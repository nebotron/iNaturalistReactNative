#!/usr/bin/env python3
"""
Evaluate the ACTUAL deployed yolov8n.onnx model (YOLO-World s fine-tuned) using
the same ImageCropper.m logic, and compare to the baseline yolov8n.pt script result.

Usage:
    python3 scripts/eval_deployed_model.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    Crop,
    bounds_to_crop,
    recall,
    precision,
    weighted_score,
    _spectral_saliency_bounds,
    _load_env,
    _fetch_firebase,
    resolve_image,
    get_image_size,
)

# ── Constants matching ImageCropper.m ────────────────────────────────────────

YOLO_INPUT_SIZE = 640
YOLO_CONF_THRESH = 0.05
YOLO_IOU_THRESH = 0.45
YOLO_GATE_CONF = 0.25
YOLO_UNION_THRESH = 0.60
YOLO_UNION_MAX_K = 3
MODEL_PATH = str(Path(__file__).parent.parent / "ios/iNaturalistReactNative/yolov8n.onnx")

PADDINGS = [0.00, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]
CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

_sess = None


def _get_session():
    global _sess
    if _sess is None:
        _sess = ort.InferenceSession(MODEL_PATH)
    return _sess


def _letterbox(img_arr: np.ndarray, size: int = 640):
    from PIL import Image
    img = Image.fromarray(img_arr)
    w, h = img.size
    scale = size / max(w, h)
    nw, nh = int(w * scale), int(h * scale)
    resized = img.resize((nw, nh), Image.BILINEAR)
    pad_left = (size - nw) // 2
    pad_top = (size - nh) // 2
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(resized, (pad_left, pad_top))
    return np.array(canvas).astype(np.float32) / 255.0, pad_left, pad_top, scale


def _nms(boxes_xyxy: np.ndarray, scores: np.ndarray, iou_thresh: float):
    order = np.argsort(scores)[::-1]
    kept = []
    while len(order) > 0:
        i = order[0]
        kept.append(i)
        if len(order) == 1:
            break
        x1 = np.maximum(boxes_xyxy[i, 0], boxes_xyxy[order[1:], 0])
        y1 = np.maximum(boxes_xyxy[i, 1], boxes_xyxy[order[1:], 1])
        x2 = np.minimum(boxes_xyxy[i, 2], boxes_xyxy[order[1:], 2])
        y2 = np.minimum(boxes_xyxy[i, 3], boxes_xyxy[order[1:], 3])
        inter = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
        area_i = (boxes_xyxy[i, 2] - boxes_xyxy[i, 0]) * (boxes_xyxy[i, 3] - boxes_xyxy[i, 1])
        area_r = (boxes_xyxy[order[1:], 2] - boxes_xyxy[order[1:], 0]) * \
                 (boxes_xyxy[order[1:], 3] - boxes_xyxy[order[1:], 1])
        union = area_i + area_r - inter
        iou = np.where(union > 0, inter / union, 0)
        order = order[1:][iou <= iou_thresh]
    return kept


def detect_deployed(image_path: str):
    """Replicate ImageCropper.m detectSubjectBoundsForImage exactly."""
    try:
        from PIL import Image as PILImage
        img = PILImage.open(image_path).convert("RGB")
        orig_w, orig_h = img.size
        img_arr = np.array(img)
    except Exception:
        return None

    lb, pad_left, pad_top, scale = _letterbox(img_arr)
    x = lb.transpose(2, 0, 1)[None]

    sess = _get_session()
    out = sess.run(None, {"images": x})[0][0]  # [5, 8400]
    cx, cy, w, h, conf = out[0], out[1], out[2], out[3], out[4]

    mask = conf >= YOLO_CONF_THRESH
    if not mask.any():
        # Fall back to saliency
        return _spectral_saliency_bounds(image_path)

    cx, cy, w, h, conf = cx[mask], cy[mask], w[mask], h[mask], conf[mask]
    x1 = cx - w / 2
    y1 = cy - h / 2
    x2 = cx + w / 2
    y2 = cy + h / 2
    boxes = np.stack([x1, y1, x2, y2], axis=1)
    kept = _nms(boxes, conf, YOLO_IOU_THRESH)

    if not kept:
        return _spectral_saliency_bounds(image_path)

    best_conf = conf[kept[0]]
    if best_conf < YOLO_GATE_CONF:
        return _spectral_saliency_bounds(image_path)

    conf_thresh2 = YOLO_UNION_THRESH * best_conf
    valid = [i for i in kept if conf[i] >= conf_thresh2][:YOLO_UNION_MAX_K] or [kept[0]]

    ux1 = min(float(boxes[i, 0]) for i in valid)
    uy1 = min(float(boxes[i, 1]) for i in valid)
    ux2 = max(float(boxes[i, 2]) for i in valid)
    uy2 = max(float(boxes[i, 3]) for i in valid)

    xn = max(0.0, min(1.0, (ux1 - pad_left) / scale / orig_w))
    yn = max(0.0, min(1.0, (uy1 - pad_top) / scale / orig_h))
    wn = max(0.01, min(1.0 - xn, (ux2 - ux1) / scale / orig_w))
    hn = max(0.01, min(1.0 - yn, (uy2 - uy1) / scale / orig_h))

    return (xn, yn, wn, hn)


def main():
    _load_env()
    base_url = os.environ.get("CROP_LOG_FIREBASE_URL", "").strip()
    if not base_url:
        sys.exit("CROP_LOG_FIREBASE_URL not set in .env")

    raw = _fetch_firebase(base_url)
    if isinstance(raw, dict) and any(
        isinstance(v, dict) and "url" in v for v in raw.values()
    ):
        raw = [v for v in raw.values() if isinstance(v, dict) and "url" in v]
    if isinstance(raw, list):
        entries_raw = [(e["url"], e) for e in raw]
    else:
        entries_raw = [(k, v["crop"]) for k, v in raw.items() if v.get("crop")]

    print(f"Loaded {len(entries_raw)} entries.\n")

    results = []
    n_yolo = 0
    n_sal = 0
    n_miss = 0

    for i, (key, crop_data) in enumerate(entries_raw, 1):
        c = crop_data.get("crop", crop_data)
        truth = Crop(c["x"], c["y"], c["w"], c["h"])

        short = key[-60:]
        if i % 50 == 0:
            print(f"  [{i}/{len(entries_raw)}] {short}")

        image_path = resolve_image(key, None, CACHE_DIR)
        if not image_path:
            n_miss += 1
            continue

        img_w, img_h = get_image_size(image_path)
        bounds = detect_deployed(image_path)
        if bounds is None:
            n_miss += 1
            continue

        results.append((truth, bounds, img_w, img_h))

    print(f"\nDetected: {len(results)}/{len(entries_raw)}\n")

    print(f"{'Padding':>8}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}")
    print("-" * 42)
    best_score = -1.0
    best_pad = 0.0
    best_rec = 0.0
    best_prec = 0.0

    for pad in PADDINGS:
        preds = [bounds_to_crop(*b, pad, w, h) for _, b, w, h in results]
        truths = [t for t, _, _, _ in results]
        recalls_ = [recall(p, t) for p, t in zip(preds, truths)]
        precisions_ = [precision(p, t) for p, t in zip(preds, truths)]
        scores_ = [weighted_score(p, t) for p, t in zip(preds, truths)]
        n = len(scores_)
        mr, mp, ms = sum(recalls_)/n, sum(precisions_)/n, sum(scores_)/n
        star = ""
        if ms > best_score:
            best_score, best_pad, best_rec, best_prec = ms, pad, mr, mp
            star = " ★"
        print(f"{pad:>8.2f}  {mr:>8.3f}  {mp:>10.3f}  {ms:>7.3f}{star}")

    print(f"\nBest: padding={best_pad}  score={best_score:.3f}  "
          f"recall={best_rec:.3f}  precision={best_prec:.3f}")
    print()


if __name__ == "__main__":
    main()
