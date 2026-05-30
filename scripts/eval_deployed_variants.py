#!/usr/bin/env python3
"""
Test algorithm variants on the deployed YOLO-World model to find the best strategy.

Variants:
  union      — current: union of all confident boxes, saliency fallback
  top1       — highest-confidence single box, saliency fallback
  smallest   — smallest-area box, saliency fallback
  sal_isect  — intersection of (union of detections) with saliency rect
  center     — box whose center is closest to image center

Usage:
    python3 scripts/eval_deployed_variants.py
"""

from __future__ import annotations

import os, sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).parent))
from eval_deployed_model import (
    detect_deployed, _get_session, _letterbox, _nms,
    YOLO_CONF_THRESH, YOLO_IOU_THRESH, YOLO_GATE_CONF,
)
from evaluate_subject_detector import (
    Crop, bounds_to_crop, recall, precision, weighted_score,
    _spectral_saliency_bounds, intersection_area,
    _load_env, _fetch_firebase, resolve_image, get_image_size,
)

CACHE_DIR = Path("/tmp/inat_eval_cache")
PADDINGS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]
YOLO_UNION_THRESH = 0.60
YOLO_UNION_MAX_K = 3


def _raw_detections(image_path: str):
    """Returns list of (x1,y1,x2,y2,conf) in normalized image coords, sorted by conf desc."""
    from PIL import Image as PILImage
    img = PILImage.open(image_path).convert("RGB")
    orig_w, orig_h = img.size
    lb, pad_left, pad_top, scale = _letterbox(np.array(img))
    x = lb.transpose(2, 0, 1)[None]
    out = _get_session().run(None, {"images": x})[0][0]
    cx, cy, w, h, conf_raw = out[0], out[1], out[2], out[3], out[4]
    mask = conf_raw >= YOLO_CONF_THRESH
    if not mask.any():
        return []
    cx, cy, w, h, conf_raw = cx[mask], cy[mask], w[mask], h[mask], conf_raw[mask]
    x1 = cx - w / 2; y1 = cy - h / 2; x2 = cx + w / 2; y2 = cy + h / 2
    boxes = np.stack([x1, y1, x2, y2], axis=1)
    kept = _nms(boxes, conf_raw, YOLO_IOU_THRESH)
    if not kept:
        return []
    best_conf = conf_raw[kept[0]]
    if best_conf < YOLO_GATE_CONF:
        return []
    # Return all post-NMS boxes, normalized to image coords
    result = []
    for i in kept:
        xn = max(0.0, min(1.0, (float(boxes[i,0]) - pad_left) / scale / orig_w))
        yn = max(0.0, min(1.0, (float(boxes[i,1]) - pad_top)  / scale / orig_h))
        wn = max(0.01, min(1.0 - xn, (float(boxes[i,2]) - float(boxes[i,0])) / scale / orig_w))
        hn = max(0.01, min(1.0 - yn, (float(boxes[i,3]) - float(boxes[i,1])) / scale / orig_h))
        result.append((xn, yn, wn, hn, float(conf_raw[i])))
    return result


def algo_union(image_path: str):
    """Current: union of top-K confident boxes, saliency fallback."""
    dets = _raw_detections(image_path)
    if not dets:
        return _spectral_saliency_bounds(image_path)
    best_conf = dets[0][4]
    thresh = YOLO_UNION_THRESH * best_conf
    valid = [(x, y, w, h) for x, y, w, h, c in dets if c >= thresh][:YOLO_UNION_MAX_K] or [(dets[0][0], dets[0][1], dets[0][2], dets[0][3])]
    x1 = min(b[0] for b in valid)
    y1 = min(b[1] for b in valid)
    x2 = max(b[0]+b[2] for b in valid)
    y2 = max(b[1]+b[3] for b in valid)
    return (x1, y1, x2-x1, y2-y1)


def algo_top1(image_path: str):
    """Highest-confidence single box."""
    dets = _raw_detections(image_path)
    if not dets:
        return _spectral_saliency_bounds(image_path)
    x, y, w, h, _ = dets[0]
    return (x, y, w, h)


def algo_smallest(image_path: str):
    """Smallest-area box."""
    dets = _raw_detections(image_path)
    if not dets:
        return _spectral_saliency_bounds(image_path)
    smallest = min(dets, key=lambda b: b[2]*b[3])
    return smallest[:4]


def algo_sal_isect(image_path: str):
    """Intersection of detection-union with saliency box. Falls back to detection-union."""
    dets = _raw_detections(image_path)
    sal = _spectral_saliency_bounds(image_path)
    if not dets:
        return sal
    u = algo_union(image_path)
    if sal is None or u is None:
        return u
    du = Crop(*u)
    sb = Crop(*sal)
    inter = intersection_area(du, sb)
    if du.w * du.h > 0 and inter / (du.w * du.h) >= 0.25:
        ix1 = max(du.x, sb.x); iy1 = max(du.y, sb.y)
        ix2 = min(du.x+du.w, sb.x+sb.w); iy2 = min(du.y+du.h, sb.y+sb.h)
        if ix2 > ix1 and iy2 > iy1:
            return (ix1, iy1, ix2-ix1, iy2-iy1)
    return u


def algo_center(image_path: str):
    """Box whose center is closest to image center."""
    dets = _raw_detections(image_path)
    if not dets:
        return _spectral_saliency_bounds(image_path)
    def dist(b): cx=b[0]+b[2]/2; cy=b[1]+b[3]/2; return (cx-.5)**2+(cy-.5)**2
    closest = min(dets, key=dist)
    return closest[:4]


ALGOS = [
    ("union (current)",  algo_union),
    ("top1",             algo_top1),
    ("smallest",         algo_smallest),
    ("sal_isect",        algo_sal_isect),
    ("center",           algo_center),
]


def main():
    _load_env()
    base_url = os.environ.get("CROP_LOG_FIREBASE_URL", "").strip()
    if not base_url:
        sys.exit("CROP_LOG_FIREBASE_URL not set in .env")

    raw = _fetch_firebase(base_url)
    if isinstance(raw, list):
        entries_raw = [(e["url"], e) for e in raw]
    else:
        entries_raw = [(k, v) for k, v in raw.items() if v.get("crop")]

    print(f"Loaded {len(entries_raw)} entries.\n")

    dataset = []
    for i, (key, crop_data) in enumerate(entries_raw, 1):
        c = crop_data.get("crop", crop_data)
        if not isinstance(c, dict) or "x" not in c:
            continue
        truth = Crop(c["x"], c["y"], c["w"], c["h"])
        image_path = resolve_image(key, None, CACHE_DIR)
        if not image_path:
            continue
        img_w, img_h = get_image_size(image_path)
        dataset.append((truth, image_path, img_w, img_h))

    print(f"Resolved {len(dataset)} images.\n")

    # Run all algorithms
    all_bounds = {name: [] for name, _ in ALGOS}
    for i, (truth, image_path, img_w, img_h) in enumerate(dataset):
        if i % 100 == 0:
            print(f"  [{i}/{len(dataset)}]")
        for name, fn in ALGOS:
            try:
                b = fn(image_path)
            except Exception:
                b = None
            all_bounds[name].append(b)

    # Evaluate
    print(f"\n{'Algorithm':<22}  {'Best Pad':>8}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}")
    print("-" * 62)

    results = []
    for name, _ in ALGOS:
        detected = [(t, b, w, h) for (t, _, w, h), b in zip(dataset, all_bounds[name]) if b is not None]
        if not detected:
            continue
        best_score = -1.0
        best_pad = PADDINGS[0]
        best_r = best_p = 0.0
        for pad in PADDINGS:
            preds = [bounds_to_crop(*b, pad, w, h) for _, b, w, h in detected]
            truths = [t for t, _, _, _ in detected]
            rs = [recall(p, t) for p, t in zip(preds, truths)]
            ps = [precision(p, t) for p, t in zip(preds, truths)]
            ss = [weighted_score(p, t) for p, t in zip(preds, truths)]
            ms = sum(ss)/len(ss)
            if ms > best_score:
                best_score = ms; best_pad = pad
                best_r = sum(rs)/len(rs); best_p = sum(ps)/len(ps)
        results.append((name, best_pad, best_r, best_p, best_score))

    results.sort(key=lambda r: r[4], reverse=True)
    for name, pad, r, p, s in results:
        print(f"{name:<22}  {pad:>8.2f}  {r:>8.3f}  {p:>10.3f}  {s:>7.3f}")

    print()
    if results:
        best = results[0]
        print(f"Winner: {best[0]}  (pad={best[1]}, score={best[4]:.3f})")
    print()


if __name__ == "__main__":
    main()
