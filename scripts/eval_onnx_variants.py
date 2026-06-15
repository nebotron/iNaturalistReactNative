#!/usr/bin/env python3
"""
Evaluate multiple ONNX model variants on crop_training.json.

Tests:
  - ios/iNaturalistReactNative/yolov8n.onnx        (current deployed, finetuned single-cls)
  - ios/iNaturalistReactNative/yolov8n_finetuned.onnx  (older finetuned version)
  - yolov8s-worldv2-int8.onnx                      (larger YOLO World model, INT8)

For each model, tests multiple algorithm variants (union, top1, smallest) and
padding values to find the best combination.

Usage:
    python3 scripts/eval_onnx_variants.py [crop_training.json]
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np
import onnxruntime as ort
from PIL import Image as PILImage

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    Crop, bounds_to_crop, recall, precision, weighted_score,
    _spectral_saliency_bounds, intersection_area,
    resolve_image, get_image_size,
)

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

PADDINGS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]

# YOLO inference constants (matching ImageCropper.m)
YOLO_INPUT_SIZE = 640
YOLO_CONF_THRESH = 0.05
YOLO_IOU_THRESH = 0.45
YOLO_GATE_CONF = 0.25
YOLO_UNION_THRESH = 0.60
YOLO_UNION_MAX_K = 3

MODELS = {
    "yolov8n_current":   REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx",
    "yolov8n_finetuned": REPO_ROOT / "ios/iNaturalistReactNative/yolov8n_finetuned.onnx",
    "yolov8s_world_int8": REPO_ROOT / "yolov8s-worldv2-int8.onnx",
}


def _letterbox(img_arr: np.ndarray, size: int = 640):
    img = PILImage.fromarray(img_arr)
    w, h = img.size
    scale = size / max(w, h)
    nw, nh = int(w * scale), int(h * scale)
    resized = img.resize((nw, nh), PILImage.BILINEAR)
    pad_left = (size - nw) // 2
    pad_top = (size - nh) // 2
    canvas = PILImage.new("RGB", (size, size), (114, 114, 114))
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
        iou_arr = np.where(union > 0, inter / union, 0)
        order = order[1:][iou_arr <= iou_thresh]
    return kept


_sessions: dict[str, ort.InferenceSession] = {}


def _get_session(model_path: Path) -> ort.InferenceSession:
    key = str(model_path)
    if key not in _sessions:
        _sessions[key] = ort.InferenceSession(key)
    return _sessions[key]


def _raw_detections(image_path: str, model_path: Path) -> list[tuple[float, float, float, float, float]]:
    """Returns (x,y,w,h,conf) list in normalized image coords, sorted by conf desc."""
    try:
        img = PILImage.open(image_path).convert("RGB")
        orig_w, orig_h = img.size
        img_arr = np.array(img)
    except Exception:
        return []

    lb, pad_left, pad_top, scale = _letterbox(img_arr)
    x = lb.transpose(2, 0, 1)[None]

    sess = _get_session(model_path)
    input_name = sess.get_inputs()[0].name
    out = sess.run(None, {input_name: x})[0][0]  # [C, 8400] or [5, 8400]

    # Handle both single-class (5 rows) and multi-class (4+N rows) outputs
    if out.shape[0] == 5:
        # Single-class: cx, cy, w, h, conf
        cx, cy, w, h, conf_raw = out[0], out[1], out[2], out[3], out[4]
    else:
        # Multi-class: cx, cy, w, h, cls0, cls1, ...
        cx, cy, w, h = out[0], out[1], out[2], out[3]
        conf_raw = out[4:].max(axis=0)  # best class score

    mask = conf_raw >= YOLO_CONF_THRESH
    if not mask.any():
        return []

    cx, cy, w, h, conf_raw = cx[mask], cy[mask], w[mask], h[mask], conf_raw[mask]
    x1 = cx - w / 2; y1 = cy - h / 2; x2 = cx + w / 2; y2 = cy + h / 2
    boxes = np.stack([x1, y1, x2, y2], axis=1)
    kept_idxs = _nms(boxes, conf_raw, YOLO_IOU_THRESH)

    if not kept_idxs:
        return []

    best_conf = conf_raw[kept_idxs[0]]
    if best_conf < YOLO_GATE_CONF:
        return []

    result = []
    for i in kept_idxs:
        xn = max(0.0, min(1.0, (float(boxes[i, 0]) - pad_left) / scale / orig_w))
        yn = max(0.0, min(1.0, (float(boxes[i, 1]) - pad_top) / scale / orig_h))
        wn = max(0.01, min(1.0 - xn, (float(boxes[i, 2]) - float(boxes[i, 0])) / scale / orig_w))
        hn = max(0.01, min(1.0 - yn, (float(boxes[i, 3]) - float(boxes[i, 1])) / scale / orig_h))
        result.append((xn, yn, wn, hn, float(conf_raw[i])))

    return sorted(result, key=lambda b: b[4], reverse=True)


def algo_union(dets, image_path):
    if not dets:
        return _spectral_saliency_bounds(image_path)
    best_conf = dets[0][4]
    thresh = YOLO_UNION_THRESH * best_conf
    valid = [(x, y, w, h) for x, y, w, h, c in dets if c >= thresh][:YOLO_UNION_MAX_K]
    if not valid:
        valid = [dets[0][:4]]
    x1 = min(b[0] for b in valid)
    y1 = min(b[1] for b in valid)
    x2 = max(b[0] + b[2] for b in valid)
    y2 = max(b[1] + b[3] for b in valid)
    return (x1, y1, x2 - x1, y2 - y1)


def algo_top1(dets, image_path):
    if not dets:
        return _spectral_saliency_bounds(image_path)
    return dets[0][:4]


def algo_smallest(dets, image_path):
    if not dets:
        return _spectral_saliency_bounds(image_path)
    return min(dets, key=lambda b: b[2] * b[3])[:4]


def algo_sal_isect(dets, image_path):
    sal = _spectral_saliency_bounds(image_path)
    if not dets:
        return sal
    u = algo_union(dets, image_path)
    if sal is None or u is None:
        return u
    du = Crop(*u)
    sb = Crop(*sal)
    inter = intersection_area(du, sb)
    if du.w * du.h > 0 and inter / (du.w * du.h) >= 0.25:
        ix1 = max(du.x, sb.x); iy1 = max(du.y, sb.y)
        ix2 = min(du.x + du.w, sb.x + sb.w); iy2 = min(du.y + du.h, sb.y + sb.h)
        if ix2 > ix1 and iy2 > iy1:
            return (ix1, iy1, ix2 - ix1, iy2 - iy1)
    return u


ALGO_FNS = [
    ("union", algo_union),
    ("top1", algo_top1),
    ("smallest", algo_smallest),
    ("sal_isect", algo_sal_isect),
]


@dataclass
class Result:
    model: str
    algo: str
    best_padding: float
    best_recall: float
    best_precision: float
    best_score: float


def evaluate_combo(entries, model_key: str, model_path: Path, algo_name: str, algo_fn) -> Result:
    detected = []
    for truth, image_path, img_w, img_h in entries:
        dets = _raw_detections(image_path, model_path)
        b = algo_fn(dets, image_path)
        if b is not None:
            detected.append((truth, b, img_w, img_h))

    best_score = -1.0
    best_pad = PADDINGS[0]
    best_r = best_p = 0.0

    for pad in PADDINGS:
        preds = [bounds_to_crop(*b, pad, w, h) for _, b, w, h in detected]
        truths = [t for t, _, _, _ in detected]
        rs = [recall(p, t) for p, t in zip(preds, truths)]
        ps = [precision(p, t) for p, t in zip(preds, truths)]
        ss = [weighted_score(p, t) for p, t in zip(preds, truths)]
        n = len(ss)
        ms = sum(ss) / n if n else 0.0
        mr = sum(rs) / n if n else 0.0
        mp = sum(ps) / n if n else 0.0
        if ms > best_score:
            best_score = ms; best_pad = pad
            best_r = mr; best_p = mp

    return Result(model_key, algo_name, best_pad, best_r, best_p, best_score)


def main():
    json_path = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "crop_training.json"
    raw = json.loads(json_path.read_text())
    if isinstance(raw, list):
        entries_raw = [(e["url"], e) for e in raw]
    else:
        entries_raw = [(k, v.get("crop", v)) for k, v in raw.items() if v.get("crop")]

    print(f"Loaded {len(entries_raw)} entries from {json_path}\n")

    # Resolve images (use cache)
    entries = []
    skipped = 0
    for key, crop_data in entries_raw:
        c = crop_data.get("crop", crop_data)
        if not isinstance(c, dict) or "x" not in c:
            continue
        truth = Crop(c["x"], c["y"], c["w"], c["h"])
        image_path = resolve_image(key, None, CACHE_DIR)
        if not image_path:
            skipped += 1
            continue
        img_w, img_h = get_image_size(image_path)
        entries.append((truth, image_path, img_w, img_h))

    print(f"Resolved {len(entries)} images ({skipped} skipped).\n")

    if not entries:
        sys.exit("No images to evaluate.")

    # Check which models exist
    available_models = {k: v for k, v in MODELS.items() if v.exists()}
    missing = set(MODELS) - set(available_models)
    if missing:
        print(f"Models not found (skipped): {', '.join(missing)}\n")

    print(f"Testing {len(available_models)} models × {len(ALGO_FNS)} algorithms …\n")

    all_results: list[Result] = []

    for model_key, model_path in available_models.items():
        print(f"  [{model_key}]")
        for algo_name, algo_fn in ALGO_FNS:
            r = evaluate_combo(entries, model_key, model_path, algo_name, algo_fn)
            all_results.append(r)
            print(f"    {algo_name:<12}  pad={r.best_padding:.2f}  "
                  f"recall={r.best_recall:.3f}  prec={r.best_precision:.3f}  score={r.best_score:.3f}")

    # Sort by score
    all_results.sort(key=lambda r: r.best_score, reverse=True)

    print("\n" + "=" * 80)
    print("RESULTS — sorted by weighted score (2×recall + 1×precision) / 3")
    print("=" * 80)
    print(f"  {'Model':<24}  {'Algo':<12}  {'Pad':>6}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}")
    print("  " + "-" * 72)
    for r in all_results:
        print(f"  {r.model:<24}  {r.algo:<12}  {r.best_padding:>6.2f}  "
              f"{r.best_recall:>8.3f}  {r.best_precision:>10.3f}  {r.best_score:>7.3f}")

    winner = all_results[0]
    current = next((r for r in all_results if r.model == "yolov8n_current" and r.algo == "union"), None)
    print(f"\nWinner: {winner.model} / {winner.algo}  "
          f"(pad={winner.best_padding}, score={winner.best_score:.3f})")
    if current:
        delta = winner.best_score - current.best_score
        sign = "+" if delta >= 0 else ""
        print(f"vs current (yolov8n_current/union): {current.best_score:.3f}  "
              f"Δ={sign}{delta:.3f}")
    print()


if __name__ == "__main__":
    main()
