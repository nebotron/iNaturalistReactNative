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


def onnx_to_pt(onnx_path: Path, out_pt: Path) -> Path:
    from ultralytics.nn.tasks import DetectionModel

    model = DetectionModel("yolov8n.yaml", nc=1)  # architecture only
    model.names = {0: "item"}
    model.args = {"single_cls": True}
    model = model.float().eval()
    model.fuse()  # BN folded away — matches the exported ONNX layout

    tensors = {t.name: numpy_helper.to_array(t)
               for t in onnx.load(str(onnx_path)).graph.initializer}

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

    # Verify the rebuilt model computes the same function as the shipped one.
    import onnxruntime as ort
    x = np.random.default_rng(0).random((1, 3, 640, 640), dtype=np.float32)
    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    reference = session.run(None, {session.get_inputs()[0].name: x})[0]
    with torch.no_grad():
        out = model(torch.from_numpy(x))
    out = (out[0] if isinstance(out, (list, tuple)) else out).numpy()
    diff = float(np.abs(out - reference).max())
    print(f"Max abs diff vs onnxruntime: {diff:.6f}")
    if diff > 1e-2:
        sys.exit("Weights did not transfer faithfully — aborting.")

    # fuse_conv_and_bn() hands back frozen convs; training needs them live again.
    for param in model.parameters():
        param.requires_grad_(True)

    torch.save({"model": model, "epoch": -1, "best_fitness": None,
                "optimizer": None, "train_args": {}, "date": "", "version": ""}, out_pt)
    print(f"Saved {out_pt}")
    return out_pt


def main() -> None:
    onnx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ONNX
    out_pt = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("/tmp/deployed_warmstart.pt")
    onnx_to_pt(onnx_path, out_pt)


if __name__ == "__main__":
    main()
