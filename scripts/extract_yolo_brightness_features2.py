#!/usr/bin/env python3
"""
Extended feature extraction for the ONNX brightness head, with exposure
augmentation.

Per image and per exposure factor f (image adjusted in linear light exactly
like ImageCropper.m's applyExposurePreservingColor; label becomes label/f):

  mean-pool   P3/P4/P5/SPPF channel means                     [704]
  wpool       objectness-weighted P3/P4/P5 channel means      [448]
  photo       in-graph photometric stats of the letterboxed
              luminance map (global + objectness-weighted
              mean / log-mean / second moment at each scale)  [12]

Everything is expressible with ONNX ops (AveragePool, Sigmoid, Mul, Div,
Log, Concat, Gemm), so any linear head trained on these bakes into the
graph. Writes /tmp/brightness_yolo_features2.npz.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image
from eval_onnx_variants import _letterbox

REPO_ROOT = Path(__file__).parent.parent
MODEL_PATH = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
CACHE_DIR = Path("/tmp/inat_eval_cache")

FEAT_TENSORS = [
    "/model.15/cv2/act/Mul_output_0",   # P3   [1,  64, 80, 80]
    "/model.18/cv2/act/Mul_output_0",   # P4   [1, 128, 40, 40]
    "/model.21/cv2/act/Mul_output_0",   # P5   [1, 256, 20, 20]
    "/model.9/cv2/act/Mul_output_0",    # SPPF [1, 256, 20, 20]
]
OBJ_TENSORS = [
    "/model.22/cv3.0/cv3.0.2/Conv_output_0",  # [1, 1, 80, 80]
    "/model.22/cv3.1/cv3.1.2/Conv_output_0",  # [1, 1, 40, 40]
    "/model.22/cv3.2/cv3.2.2/Conv_output_0",  # [1, 1, 20, 20]
]

EXPOSURE_FACTORS = [0.4, 0.55, 0.7, 0.85, 1.0, 1.2, 1.4]
LOG_CLIP = 1e-4  # matches measureCropLuminance / compute_brightness_crop_features


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def apply_exposure(img01: np.ndarray, f: float) -> np.ndarray:
    """Color-preserving linear-light exposure, same as the app."""
    lin = srgb_to_linear(img01) * f
    m = lin.max(axis=-1, keepdims=True)
    scale = np.where(m > 1.0, 1.0 / np.maximum(m, 1e-9), 1.0)
    return np.clip(linear_to_srgb(lin * scale), 0.0, 1.0)


def build_session() -> ort.InferenceSession:
    model = onnx.load(str(MODEL_PATH))
    existing = {o.name for o in model.graph.output}
    for name in FEAT_TENSORS + OBJ_TENSORS:
        if name not in existing:
            model.graph.output.append(onnx.helper.make_empty_tensor_value_info(name))
    return ort.InferenceSession(model.SerializeToString(),
                                providers=["CPUExecutionProvider"])


def avgpool(x: np.ndarray, k: int) -> np.ndarray:
    """[H,W] -> [H/k, W/k] average pooling."""
    h, w = x.shape
    return x[: h - h % k, : w - w % k].reshape(h // k, k, w // k, k).mean(axis=(1, 3))


def features_for(sess: ort.InferenceSession, lb: np.ndarray) -> np.ndarray:
    x = lb.transpose(2, 0, 1)[None]
    outs = sess.run(FEAT_TENSORS + OBJ_TENSORS, {"images": x})
    fmaps = outs[:4]
    objs = [1.0 / (1.0 + np.exp(-o[0, 0])) for o in outs[4:]]  # sigmoid

    mean_pool = np.concatenate([o[0].mean(axis=(1, 2)) for o in fmaps])

    wpool = []
    for fmap, w in zip(fmaps[:3], objs):
        num = (fmap[0] * w[None]).mean(axis=(1, 2))
        den = w.mean() + 1e-6
        wpool.append(num / den)
    wpool = np.concatenate(wpool)

    # Photometric stats of the letterboxed luminance map, at stride 8 (80x80)
    lum = 0.299 * lb[..., 0] + 0.587 * lb[..., 1] + 0.114 * lb[..., 2]
    lum80 = avgpool(lum, 8)
    loglum80 = np.log(np.maximum(lum80, LOG_CLIP))
    photo = [lum80.mean(), loglum80.mean(), (lum80 ** 2).mean()]
    for w in objs:
        w80 = w if w.shape == (80, 80) else np.kron(
            w, np.ones((80 // w.shape[0], 80 // w.shape[1])))
        den = w80.mean() + 1e-6
        photo += [(lum80 * w80).mean() / den,
                  (loglum80 * w80).mean() / den,
                  ((lum80 ** 2) * w80).mean() / den]
    photo = np.array(photo)

    return np.concatenate([mean_pool, wpool, photo])


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-aug", action="store_true",
                    help="Only extract the f=1.0 row per image (7x faster; "
                         "augmented rows hurt accuracy in past sessions)")
    args = ap.parse_args()
    exposure_factors = [1.0] if args.no_aug else EXPOSURE_FACTORS

    raw = json.loads((REPO_ROOT / "brightness_training.json").read_text())
    sess = build_session()
    # If the deployed model already carries a baked brightness head, capture its
    # prediction per f=1.0 row so refits can be compared against it directly.
    has_deployed_head = any(o.name == "brightness" for o in sess.get_outputs())

    feats, labels, groups, factors, deployed = [], [], [], [], []
    for i, e in enumerate(raw):
        if not isinstance(e.get("brightness"), (int, float)):
            print(f"  skip (no label): {e['url']}")
            continue
        path = resolve_image(e["url"], None, CACHE_DIR)
        if not path:
            print(f"  skip (no image): {e['url']}")
            continue
        img01 = np.array(Image.open(path).convert("RGB")).astype(np.float32) / 255.0
        for f in exposure_factors:
            adj = img01 if f == 1.0 else apply_exposure(img01, f)
            lb, *_ = _letterbox((adj * 255.0).astype(np.uint8))
            feats.append(features_for(sess, lb))
            labels.append(e["brightness"] / f)
            groups.append(i)
            factors.append(f)
            if has_deployed_head:
                x = lb.transpose(2, 0, 1)[None]
                deployed.append(float(sess.run(["brightness"], {"images": x})[0][0, 0]))
        if (i + 1) % 20 == 0:
            print(f"  {i + 1}/{len(raw)}")

    np.savez("/tmp/brightness_yolo_features2.npz",
             feats=np.array(feats, dtype=np.float32),
             labels=np.array(labels, dtype=np.float32),
             groups=np.array(groups), factors=np.array(factors),
             deployed=np.array(deployed, dtype=np.float32))
    print(f"Wrote {len(feats)} rows ({len(raw)} images x {len(exposure_factors)} exposures)")


if __name__ == "__main__":
    main()
