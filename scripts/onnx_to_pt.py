#!/usr/bin/env python3
"""
Rebuild a trainable ultralytics checkpoint from the deployed (fused) ONNX model,
so fine-tuning can resume from the deployed weights instead of restarting from
the stock COCO checkpoint.

Ultralytics fuses Conv+BN on export, so the ONNX initializers map 1:1 onto a
*fused* DetectionModel (BN gone, conv carrying a bias) and keep their torch
module names. This builds that model, loads the ONNX tensors by name, verifies
the torch output matches onnxruntime, and writes a .pt that YOLO() can train.

Usage:
    python3 scripts/onnx_to_pt.py [model.onnx] [out.pt]
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import numpy_helper

REPO_ROOT = Path(__file__).parent.parent
DEFAULT_ONNX = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
CALIB_IMAGES = 128   # enough for stable per-channel statistics
VAR_FLOOR = 1e-4     # keeps gamma = sqrt(var) from collapsing a dead channel


def _match_sppf_activation(model, graph) -> None:
    """Give SPPF's cv1 whichever activation the exported graph actually used.

    ultralytics 8.4.123 (which exported the model deployed in August) built
    YOLOv8's SPPF with the unactivated cv1 that YOLO26 introduced; 8.4.157
    restores SiLU there for legacy YAMLs. The deployed weights were trained
    against whatever the exporter built, so the warm start has to reproduce it
    or every layer from SPPF on computes a different function — silently, since
    the tensor names and shapes still line up.
    """
    import torch.nn as nn
    from ultralytics.nn.modules.block import SPPF

    for idx, module in enumerate(model.model):
        if not isinstance(module, SPPF):
            continue
        conv_out = f"/model.{idx}/cv1/conv/Conv_output_0"
        activated = any(conv_out in node.input and node.op_type in ("Sigmoid", "Mul")
                        for node in graph.node)
        want = nn.SiLU() if activated else nn.Identity()
        if type(module.cv1.act) is not type(want):
            print(f"SPPF at model.{idx}: cv1 activation "
                  f"{type(module.cv1.act).__name__} → {type(want).__name__} to match the ONNX")
            module.cv1.act = want
        if not activated:
            _pin_unactivated_sppf_in_yaml(model)


def _pin_unactivated_sppf_in_yaml(model) -> None:
    """Spell the pooling count out in the checkpoint's YAML so a rebuild keeps Identity.

    The trainer does not train the object we hand it: it re-parses `model.yaml`
    and copies the weights in. parse_model only restores the legacy SiLU when
    the SPPF row is short enough to predate it, so writing the default n=3 into
    the row keeps the unactivated form through every later rebuild and export.
    """
    for section in ("backbone", "head"):
        for row in model.yaml.get(section, []):
            if len(row) >= 4 and row[2] == "SPPF" and len(row[3]) <= 2:
                row[3] = [*row[3], 3]


def onnx_to_pt(onnx_path: Path, out_pt: Path, calib_images=None) -> Path:
    from ultralytics.nn.tasks import DetectionModel

    graph = onnx.load(str(onnx_path)).graph

    model = DetectionModel("yolov8n.yaml", nc=1)  # architecture only
    model.names = {0: "item"}
    model.args = {"single_cls": True}
    model = model.float().eval()
    _match_sppf_activation(model, graph)
    model.fuse()  # BN folded away — matches the exported ONNX layout

    tensors = {t.name: numpy_helper.to_array(t) for t in graph.initializer}

    state = model.state_dict()
    new_state = {}
    missing = []
    for name, param in state.items():
        tensor = tensors.get(name)
        if tensor is None or tuple(tensor.shape) != tuple(param.shape):
            missing.append(name)
            new_state[name] = param
            continue
        new_state[name] = torch.from_numpy(np.ascontiguousarray(tensor)).to(param.dtype)
    model.load_state_dict(new_state, strict=True)
    print(f"Loaded {len(state) - len(missing)}/{len(state)} tensors from {onnx_path.name}")
    if missing:
        sys.exit(f"Tensors missing from the ONNX graph: {missing[:10]}")

    import onnxruntime as ort
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    _assert_matches_onnx(model, session, "fused")

    trainable = _unfuse(model, onnx_path, calib_images)
    _assert_matches_onnx(trainable, session, "unfused")

    for param in trainable.parameters():
        param.requires_grad_(True)

    torch.save({"model": trainable, "epoch": -1, "best_fitness": None,
                "optimizer": None, "train_args": {}, "date": "", "version": ""}, out_pt)
    print(f"Saved {out_pt}")
    return out_pt


def _assert_matches_onnx(model, session, label: str) -> None:
    """A warm start that silently computes a different function is worse than none."""
    x = np.random.default_rng(0).random((1, 3, 640, 640), dtype=np.float32)
    reference = session.run(None, {session.get_inputs()[0].name: x})[0]
    with torch.no_grad():
        out = model.eval()(torch.from_numpy(x))
    out = (out[0] if isinstance(out, (list, tuple)) else out).numpy()
    diff = float(np.abs(out - reference).max())
    print(f"Max abs diff vs onnxruntime ({label}): {diff:.6f}")
    if diff > 1e-2:
        sys.exit(f"Weights did not transfer faithfully ({label}) — aborting.")


def _unfuse(fused, onnx_path: Path, calib_images):
    """Turn the fused model back into the Conv+BN one the trainer expects.

    The trainer never trains the object it is given: it re-parses the YAML into
    an *unfused* DetectionModel and copies weights across by name. A fused
    checkpoint has no BN tensors to copy, so only the handful of bare Conv2d
    layers transfer and the warm start is quietly thrown away — ultralytics says
    as much ("train from the unfused checkpoint instead") and carries on.

    Each fused conv computes `W·x + b`. Putting W in the unfused conv and giving
    its BatchNorm gamma = sqrt(var + eps), beta = mean + b, running stats
    (mean, var) reproduces `W·x + b` exactly in eval mode for *any* mean/var, so
    correctness does not depend on the calibration. What the calibration buys is
    a BN whose running statistics match the activations it will actually see, so
    that the first training batches — which normalize by batch statistics rather
    than running ones — compute the same function too, instead of renormalizing
    activations the fused weights were never scaled for.
    """
    from ultralytics.nn.modules.conv import Conv
    from ultralytics.nn.tasks import DetectionModel

    unfused = DetectionModel(fused.yaml, nc=1, verbose=False)
    unfused.names = dict(fused.names)
    unfused.args = dict(fused.args) if isinstance(fused.args, dict) else fused.args
    unfused = unfused.float().eval()

    fused_convs = {n: m for n, m in fused.named_modules() if isinstance(m, Conv)}
    stats = _calibrate(fused, fused_convs, onnx_path, calib_images)

    copied = set()
    for name, module in unfused.named_modules():
        if not isinstance(module, Conv) or name not in fused_convs:
            continue
        src = fused_convs[name]
        module.conv.weight.data.copy_(src.conv.weight.data)
        bias = src.conv.bias.data
        mean, var = stats[name]
        eps = module.bn.eps
        module.bn.running_mean.data.copy_(mean)
        module.bn.running_var.data.copy_(var)
        module.bn.weight.data.copy_(torch.sqrt(var + eps))
        module.bn.bias.data.copy_(mean + bias)
        module.act = src.act
        copied.update({f"{name}.conv.weight", f"{name}.bn.weight", f"{name}.bn.bias",
                       f"{name}.bn.running_mean", f"{name}.bn.running_var"})

    # Everything outside a Conv+BN pair (the Detect head's bare convs, DFL)
    # transfers unchanged.
    fused_state = fused.state_dict()
    leftovers = {k: fused_state[k] for k, v in unfused.state_dict().items()
                 if k not in copied and k in fused_state and fused_state[k].shape == v.shape}
    unfused.load_state_dict(leftovers, strict=False)
    print(f"Un-fused {len(fused_convs)} Conv+BN blocks, "
          f"copied {len(leftovers)} remaining tensors")
    return unfused


def _calibrate(fused, fused_convs, onnx_path: Path, calib_images):
    """Per-channel mean/variance of each conv's output over real images."""
    paths = calib_images or sorted(Path("/tmp/inat_eval_cache").glob("*.jpg"))[:CALIB_IMAGES]
    paths = list(paths)[:CALIB_IMAGES]
    acc = {n: [torch.zeros(m.conv.out_channels, dtype=torch.float64),
               torch.zeros(m.conv.out_channels, dtype=torch.float64), 0]
           for n, m in fused_convs.items()}

    handles = []
    for name, module in fused_convs.items():
        def hook(_m, _inp, out, name=name):
            o = out.detach().double()
            acc[name][0] += o.sum(dim=(0, 2, 3))
            acc[name][1] += (o * o).sum(dim=(0, 2, 3))
            acc[name][2] += o.shape[0] * o.shape[2] * o.shape[3]
        handles.append(module.conv.register_forward_hook(hook))

    if not paths:
        print("No calibration images found — BN will start from identity statistics.")
    for i, p in enumerate(paths):
        with torch.no_grad():
            fused(torch.from_numpy(_letterboxed(p))[None])
        if (i + 1) % 32 == 0:
            print(f"  calibrated on {i + 1}/{len(paths)} images", flush=True)
    for h in handles:
        h.remove()

    stats = {}
    for name, module in fused_convs.items():
        total, total_sq, count = acc[name]
        if count == 0:
            c = module.conv.out_channels
            stats[name] = (torch.zeros(c), torch.ones(c))
            continue
        mean = total / count
        var = torch.clamp(total_sq / count - mean * mean, min=VAR_FLOOR)
        bias = module.conv.bias.data.double()
        stats[name] = ((mean - bias).float(), var.float())
    return stats


def _letterboxed(path: Path) -> np.ndarray:
    from PIL import Image
    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = 640 / max(w, h)
    resized = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)
    canvas = Image.new("RGB", (640, 640), (114, 114, 114))
    canvas.paste(resized, ((640 - resized.width) // 2, (640 - resized.height) // 2))
    return np.array(canvas).astype(np.float32).transpose(2, 0, 1) / 255.0


def main() -> None:
    onnx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ONNX
    out_pt = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/deployed_warmstart.pt")
    onnx_to_pt(onnx_path, out_pt)


if __name__ == "__main__":
    main()
