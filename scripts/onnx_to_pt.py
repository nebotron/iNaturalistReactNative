#!/usr/bin/env python3
"""
Reconstruct a trainable ultralytics .pt checkpoint from a BN-fused YOLOv8 ONNX
export (e.g. the deployed ios/iNaturalistReactNative/yolov8n.onnx).

Why: remote tune environments block every pretrained-weight source (github
release assets, huggingface, download.pytorch.org), so the only way to warm-
start a retrain is to recover weights from the ONNX already in the repo.

How:
  1. Build DetectionModel('yolov8n.yaml', nc=1) and copy the fused conv
     weights from the ONNX initializers (ultralytics exports keep original
     names like `model.0.conv.weight`).
  2. The fused conv bias belongs to the folded BatchNorm. BN is first set to
     identity (exact eval-mode parity), then *calibrated*: per-channel
     activation statistics are measured on real images from the eval cache and
     folded into (gamma, beta, running stats) so that train-mode forward also
     matches the original function. Without this, train-mode batch statistics
     would scramble the learned function on the first epochs.
  3. Verify parity vs onnxruntime and save a YOLO()-loadable checkpoint.

Usage:
    python3 scripts/onnx_to_pt.py [src.onnx] [out.pt]
        defaults: ios/iNaturalistReactNative/yolov8n.onnx  deployed_recon.pt
Requires images in /tmp/inat_eval_cache (run an eval script first).
"""
import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import numpy_helper
import torch
import torch.nn as nn

REPO = Path(__file__).parent.parent
ONNX_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "ios/iNaturalistReactNative/yolov8n.onnx"
OUT_PT = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("deployed_recon.pt")
CACHE = Path("/tmp/inat_eval_cache")

m_onnx = onnx.load(str(ONNX_PATH))
inits = {i.name: numpy_helper.to_array(i) for i in m_onnx.graph.initializer}
print(f"{len(inits)} initializers from {ONNX_PATH}")

from ultralytics.nn.tasks import DetectionModel
model = DetectionModel(cfg="yolov8n.yaml", ch=3, nc=1, verbose=False)
model.eval()

used = set()
fused_bias = {}  # bn module name -> fused conv bias

for name, mod in model.named_modules():
    if isinstance(mod, nn.Conv2d):
        wkey, bkey = f"{name}.weight", f"{name}.bias"
        if wkey not in inits:
            continue
        w = torch.from_numpy(inits[wkey].copy())
        assert w.shape == mod.weight.shape, f"{name}: {w.shape} vs {mod.weight.shape}"
        mod.weight.data.copy_(w)
        used.add(wkey)
        if mod.bias is not None:
            mod.bias.data.copy_(torch.from_numpy(inits[bkey].copy()))
            used.add(bkey)
        elif bkey in inits:
            bn_name = name.rsplit(".", 1)[0] + ".bn"
            fused_bias[bn_name] = torch.from_numpy(inits[bkey].copy())
            used.add(bkey)

unused = set(inits) - used
assert not unused, f"unused initializers: {unused}"

for name, mod in model.named_modules():
    if isinstance(mod, nn.BatchNorm2d):
        b = fused_bias.get(name)
        assert b is not None, f"no fused bias for {name}"
        mod.weight.data.fill_(1.0)
        mod.bias.data.copy_(b)
        mod.running_mean.data.zero_()
        mod.running_var.data.fill_(1.0 - mod.eps)
        mod.num_batches_tracked.data.zero_()

import onnxruntime as ort
sess = ort.InferenceSession(str(ONNX_PATH))
rng = np.random.default_rng(0)
x = rng.random((1, 3, 640, 640), dtype=np.float32)
ref = sess.run(None, {sess.get_inputs()[0].name: x})[0]
with torch.no_grad():
    out = model(torch.from_numpy(x))
    out = out[0] if isinstance(out, (list, tuple)) else out
diff = np.abs(out.numpy() - ref).max()
print(f"eval parity (identity BN): {diff:.2e}")
assert diff < 1e-2

# calibrate BN on real images so train-mode forward matches too
imgs = sorted(CACHE.glob("*.jpg"))[:192]
assert imgs, f"no images in {CACHE}; run an eval first to populate it"
from PIL import Image as PILImage

def letterbox(path):
    img = PILImage.open(path).convert("RGB")
    w, h = img.size
    s = 640 / max(w, h)
    r = img.resize((int(w*s), int(h*s)), PILImage.BILINEAR)
    canvas = PILImage.new("RGB", (640, 640), (114, 114, 114))
    canvas.paste(r, ((640-r.size[0])//2, (640-r.size[1])//2))
    return np.array(canvas).astype(np.float32).transpose(2, 0, 1) / 255.0

stats = {}
hooks = []
def mk_hook(name):
    def hook(mod, inp, out):
        xh = inp[0].detach()
        c = xh.shape[1]
        xf = xh.transpose(0, 1).reshape(c, -1)
        st = stats.setdefault(name, [0, torch.zeros(c, dtype=torch.float64), torch.zeros(c, dtype=torch.float64)])
        st[0] += xf.shape[1]
        st[1] += xf.sum(dim=1, dtype=torch.float64)
        st[2] += (xf.double() ** 2).sum(dim=1)
    return hook

for name, mod in model.named_modules():
    if isinstance(mod, nn.BatchNorm2d):
        hooks.append(mod.register_forward_hook(mk_hook(name)))
with torch.no_grad():
    for i in range(0, len(imgs), 8):
        model(torch.from_numpy(np.stack([letterbox(p) for p in imgs[i:i+8]])))
for h in hooks:
    h.remove()

for name, mod in model.named_modules():
    if isinstance(mod, nn.BatchNorm2d):
        n, s, ss = stats[name]
        mu = (s / n).float()
        var = ((ss / n) - (s / n) ** 2).float().clamp_min(1e-6)
        mod.weight.data.copy_(torch.sqrt(var + mod.eps))
        mod.bias.data.copy_(mu + fused_bias[name])
        mod.running_mean.data.copy_(mu)
        mod.running_var.data.copy_(var)

with torch.no_grad():
    out = model(torch.from_numpy(x))
    out = out[0] if isinstance(out, (list, tuple)) else out
diff = np.abs(out.numpy() - ref).max()
print(f"eval parity (calibrated): {diff:.3e} (rel {diff/np.abs(ref).max():.2e})")

from ultralytics.cfg import DEFAULT_CFG_DICT
model.args = DEFAULT_CFG_DICT
torch.save({"model": model, "epoch": -1, "train_args": {"task": "detect"}}, OUT_PT)
print(f"saved {OUT_PT}")

from ultralytics import YOLO
YOLO(str(OUT_PT))
print("YOLO() load ok")
