#!/usr/bin/env python3
"""
Extract frozen intermediate features from the deployed yolov8n.onnx for every
image in brightness_training.json. Features are global-average-pooled neck
outputs (P3/P4/P5, the Detect head inputs) plus the SPPF output — the same
tensors a baked-in brightness head would read — so a regression trained on
them transfers exactly to an ONNX-graph head.

Writes /tmp/brightness_yolo_features.npz with:
  feats  [N, 704]  (64 P3 + 128 P4 + 256 P5 + 256 SPPF channel means)
  labels [N]       human-picked brightness multiplier
  urls   [N]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image
from eval_onnx_variants import _letterbox

REPO_ROOT = Path(__file__).parent.parent
MODEL_PATH = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
CACHE_DIR = Path("/tmp/inat_eval_cache")

FEATURE_TENSORS = [
    "/model.15/cv2/act/Mul_output_0",   # P3  [1,  64, 80, 80]
    "/model.18/cv2/act/Mul_output_0",   # P4  [1, 128, 40, 40]
    "/model.21/cv2/act/Mul_output_0",   # P5  [1, 256, 20, 20]
    "/model.9/cv2/act/Mul_output_0",    # SPPF [1, 256, 20, 20]
]


def build_feature_session() -> ort.InferenceSession:
    model = onnx.load(str(MODEL_PATH))
    existing = {o.name for o in model.graph.output}
    for name in FEATURE_TENSORS:
        if name not in existing:
            model.graph.output.append(onnx.helper.make_empty_tensor_value_info(name))
    return ort.InferenceSession(model.SerializeToString(),
                                providers=["CPUExecutionProvider"])


def main() -> None:
    raw = json.loads((REPO_ROOT / "brightness_training.json").read_text())
    sess = build_feature_session()

    feats, labels, urls = [], [], []
    for i, e in enumerate(raw):
        path = resolve_image(e["url"], None, CACHE_DIR)
        if not path:
            print(f"  skip (no image): {e['url']}")
            continue
        from PIL import Image
        img = np.array(Image.open(path).convert("RGB"))
        lb, *_ = _letterbox(img)
        x = lb.transpose(2, 0, 1)[None]
        outs = sess.run(FEATURE_TENSORS, {"images": x})
        pooled = np.concatenate([o[0].mean(axis=(1, 2)) for o in outs])
        feats.append(pooled)
        labels.append(e["brightness"])
        urls.append(e["url"])
        if (i + 1) % 25 == 0:
            print(f"  {i + 1}/{len(raw)}")

    np.savez("/tmp/brightness_yolo_features.npz",
             feats=np.array(feats, dtype=np.float32),
             labels=np.array(labels, dtype=np.float32),
             urls=np.array(urls))
    print(f"Wrote {len(feats)} feature rows to /tmp/brightness_yolo_features.npz")


if __name__ == "__main__":
    main()
