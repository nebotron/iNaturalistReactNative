#!/usr/bin/env python3
"""
Bake the ridge brightness head (SPPF mean-pool + 12 photometric stats,
alpha=100 — see train_brightness_head2.py) into yolov8n.onnx as a second
graph output "brightness" [1,1]: the clamped [0.4, 3.0] exposure multiplier.

The head reads only tensors already in the graph (SPPF activations, the
Detect-head objectness logits, and the network input), so detection output0
is untouched. Verifies output0 parity and head parity before overwriting
the deployed model.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
import onnxruntime as ort

REPO_ROOT = Path(__file__).parent.parent
MODEL_PATH = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
FEATURES_NPZ = "/tmp/brightness_yolo_features2.npz"

ALPHA = 100.0
CLAMP_LO, CLAMP_HI = 0.4, 3.0
LOG_CLIP = 1e-4
W_EPS = 1e-6

SPPF = "/model.9/cv2/act/Mul_output_0"            # [1, 256, 20, 20]
OBJ = {                                            # objectness logits
    "p3": ("/model.22/cv3.0/cv3.0.2/Conv_output_0", 1),   # 80x80, pool k
    "p4": ("/model.22/cv3.1/cv3.1.2/Conv_output_0", 2),   # 40x40
    "p5": ("/model.22/cv3.2/cv3.2.2/Conv_output_0", 4),   # 20x20
}


def fit_head() -> tuple[np.ndarray, float]:
    """Final full-data ridge fit; returns raw-space affine (w [268], b)."""
    d = np.load(FEATURES_NPZ)
    X_all = d["feats"].astype(np.float64)
    y_all = d["labels"].astype(np.float64)
    orig = d["factors"] == 1.0
    cols = np.r_[448:704, 1152:1164]  # SPPF mean-pool + photo12
    X, logy = X_all[orig][:, cols], np.log(y_all[orig])

    mu, sd = X.mean(0), X.std(0) + 1e-8
    Xs = (X - mu) / sd
    w_std = np.linalg.solve(Xs.T @ Xs + ALPHA * np.eye(Xs.shape[1]),
                            Xs.T @ (logy - logy.mean()))
    w_raw = w_std / sd
    b_raw = float(logy.mean() - (w_std * mu / sd).sum())
    return w_raw, b_raw


def const(name: str, value, dtype=np.float32) -> onnx.TensorProto:
    arr = np.asarray(value, dtype=dtype)
    return numpy_helper.from_array(arr, name=name)


def strip_existing_head(g: onnx.GraphProto) -> None:
    """Remove a previously-baked head (bh_* nodes/initializers, brightness
    output) so the model can be re-baked with fresh coefficients."""
    def is_head_node(nd):
        return nd.name.startswith("/bhead") or any(
            o == "brightness" or o.startswith("bh_") for o in nd.output)
    keep_nodes = [nd for nd in g.node if not is_head_node(nd)]
    if len(keep_nodes) != len(g.node):
        del g.node[:]
        g.node.extend(keep_nodes)
    keep_inits = [it for it in g.initializer if not it.name.startswith("bh_")]
    if len(keep_inits) != len(g.initializer):
        del g.initializer[:]
        g.initializer.extend(keep_inits)
    keep_outs = [o for o in g.output if o.name != "brightness"]
    if len(keep_outs) != len(g.output):
        del g.output[:]
        g.output.extend(keep_outs)


def bake(w_raw: np.ndarray, b_raw: float) -> onnx.ModelProto:
    model = onnx.load(str(MODEL_PATH))
    g = model.graph
    strip_existing_head(g)
    nodes, inits = [], []

    def n(op, inputs, outputs, **attrs):
        nodes.append(helper.make_node(op, inputs, outputs,
                                      name=f"/bhead{outputs[0]}", **attrs))

    # Luminance of the letterboxed input, pooled to 80x80
    inits.append(const("bh_lum_w", np.array([0.299, 0.587, 0.114],
                                            np.float32).reshape(1, 3, 1, 1)))
    n("Conv", ["images", "bh_lum_w"], ["bh_lum"])
    n("AveragePool", ["bh_lum"], ["bh_lum80"], kernel_shape=[8, 8], strides=[8, 8])
    inits.append(const("bh_logclip", np.float32(LOG_CLIP)))
    n("Clip", ["bh_lum80", "bh_logclip"], ["bh_lumc"])
    n("Log", ["bh_lumc"], ["bh_loglum80"])
    n("Mul", ["bh_lum80", "bh_lum80"], ["bh_sq80"])

    photo = []  # names of [1,1,1,1] scalars, in training feature order

    for src in ["bh_lum80", "bh_loglum80", "bh_sq80"]:
        n("GlobalAveragePool", [src], [f"{src}_gm"])
        photo.append(f"{src}_gm")

    inits.append(const("bh_eps", np.float32(W_EPS)))
    for scale, (logit, k) in OBJ.items():
        wname = f"bh_w_{scale}"
        n("Sigmoid", [logit], [wname])
        n("GlobalAveragePool", [wname], [f"{wname}_m"])
        n("Add", [f"{wname}_m", "bh_eps"], [f"{wname}_den"])
        for src in ["bh_lum80", "bh_loglum80", "bh_sq80"]:
            pooled = src
            if k > 1:
                pooled = f"{src}_k{k}"
                if not any(nd.output[0] == pooled for nd in nodes):
                    n("AveragePool", [src], [pooled],
                      kernel_shape=[k, k], strides=[k, k])
            n("Mul", [pooled, wname], [f"{src}_{scale}_wx"])
            n("GlobalAveragePool", [f"{src}_{scale}_wx"], [f"{src}_{scale}_num"])
            n("Div", [f"{src}_{scale}_num", f"{wname}_den"], [f"{src}_{scale}_wm"])
            photo.append(f"{src}_{scale}_wm")

    # SPPF channel means + flatten everything to [1, C]
    n("GlobalAveragePool", [SPPF], ["bh_sppf_gap"])
    n("Flatten", ["bh_sppf_gap"], ["bh_sppf_flat"], axis=1)
    flat_photo = []
    for p in photo:
        n("Flatten", [p], [f"{p}_f"], axis=1)
        flat_photo.append(f"{p}_f")
    n("Concat", ["bh_sppf_flat"] + flat_photo, ["bh_feats"], axis=1)

    # Affine head in log space, then exp + clamp
    inits.append(const("bh_head_w", w_raw.astype(np.float32).reshape(1, -1)))
    inits.append(const("bh_head_b", np.array([b_raw], np.float32)))
    n("Gemm", ["bh_feats", "bh_head_w", "bh_head_b"], ["bh_log"], transB=1)
    n("Exp", ["bh_log"], ["bh_exp"])
    inits.append(const("bh_lo", np.float32(CLAMP_LO)))
    inits.append(const("bh_hi", np.float32(CLAMP_HI)))
    n("Clip", ["bh_exp", "bh_lo", "bh_hi"], ["brightness"])

    g.node.extend(nodes)
    g.initializer.extend(inits)
    g.output.append(helper.make_tensor_value_info(
        "brightness", TensorProto.FLOAT, [1, 1]))
    onnx.checker.check_model(model)
    return model


def verify(model: onnx.ModelProto, w_raw: np.ndarray, b_raw: float) -> None:
    sys.path.insert(0, str(Path(__file__).parent))
    from eval_onnx_variants import _letterbox
    from evaluate_subject_detector import resolve_image
    from PIL import Image
    import json

    old_sess = ort.InferenceSession(str(MODEL_PATH),
                                    providers=["CPUExecutionProvider"])
    new_sess = ort.InferenceSession(model.SerializeToString(),
                                    providers=["CPUExecutionProvider"])

    d = np.load(FEATURES_NPZ)
    cols = np.r_[448:704, 1152:1164]
    orig = d["factors"] == 1.0
    X, y = d["feats"][orig][:, cols].astype(np.float64), d["labels"][orig]

    raw = json.loads((REPO_ROOT / "brightness_training.json").read_text())
    max_out_diff, max_head_diff = 0.0, 0.0
    for i in [0, 25, 50, 100, 150, 192]:
        path = resolve_image(raw[i]["url"], None, Path("/tmp/inat_eval_cache"))
        lb, *_ = _letterbox(np.array(Image.open(path).convert("RGB")))
        x = lb.transpose(2, 0, 1)[None]
        out_old = old_sess.run(["output0"], {"images": x})[0]
        out_new, bright = new_sess.run(["output0", "brightness"], {"images": x})
        expected = float(np.clip(np.exp(X[i] @ w_raw + b_raw),
                                 CLAMP_LO, CLAMP_HI))
        max_out_diff = max(max_out_diff, float(np.abs(out_old - out_new).max()))
        max_head_diff = max(max_head_diff, abs(float(bright[0, 0]) - expected))
        print(f"  img {i}: brightness={float(bright[0, 0]):.4f} "
              f"expected={expected:.4f} label={y[i]:.3f}")
    print(f"max |output0 old-new| = {max_out_diff:.2e}")
    print(f"max |head onnx-python| = {max_head_diff:.2e}")
    assert max_out_diff == 0.0, "detection output changed!"
    assert max_head_diff < 5e-3, "head parity failure"


def main() -> None:
    w_raw, b_raw = fit_head()
    print(f"head: {len(w_raw)} weights, intercept {b_raw:.4f}")
    model = bake(w_raw, b_raw)
    verify(model, w_raw, b_raw)
    onnx.save(model, str(MODEL_PATH))
    print(f"Saved {MODEL_PATH}")


if __name__ == "__main__":
    main()
