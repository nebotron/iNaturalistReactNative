#!/usr/bin/env python3
"""
Tune YOLO inference thresholds on the deployed yolov8n.onnx model.

Tests combinations of:
  - union_thresh: fraction of best_conf required to include a box in union (0.3–0.9)
  - gate_conf:    minimum best_conf to use YOLO at all (0.05–0.25)
  - iou_thresh:   NMS IoU threshold (0.30–0.55)
  - top-K union:  include only top K boxes in union (1–5)

Reports the best combination by weighted score.

Usage:
    python3 scripts/tune_thresholds.py [crop_training.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image as PILImage

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    Crop, bounds_to_crop, recall, precision, weighted_score,
    _spectral_saliency_bounds, resolve_image, get_image_size,
)

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
MODEL_PATH = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"
PADDINGS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25]
YOLO_INPUT_SIZE = 640
YOLO_CONF_THRESH = 0.05  # fixed — minimum to even consider a box

_sess = None


def _get_session():
    global _sess
    if _sess is None:
        _sess = ort.InferenceSession(str(MODEL_PATH))
    return _sess


def _letterbox(img_arr, size=640):
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


def _nms(boxes_xyxy, scores, iou_thresh):
    order = np.argsort(scores)[::-1]
    kept = []
    while len(order) > 0:
        i = order[0]; kept.append(i)
        if len(order) == 1: break
        x1 = np.maximum(boxes_xyxy[i,0], boxes_xyxy[order[1:],0])
        y1 = np.maximum(boxes_xyxy[i,1], boxes_xyxy[order[1:],1])
        x2 = np.minimum(boxes_xyxy[i,2], boxes_xyxy[order[1:],2])
        y2 = np.minimum(boxes_xyxy[i,3], boxes_xyxy[order[1:],3])
        inter = np.maximum(0, x2-x1) * np.maximum(0, y2-y1)
        area_i = (boxes_xyxy[i,2]-boxes_xyxy[i,0]) * (boxes_xyxy[i,3]-boxes_xyxy[i,1])
        area_r = (boxes_xyxy[order[1:],2]-boxes_xyxy[order[1:],0]) * \
                 (boxes_xyxy[order[1:],3]-boxes_xyxy[order[1:],1])
        union = area_i + area_r - inter
        iou = np.where(union > 0, inter / union, 0)
        order = order[1:][iou <= iou_thresh]
    return kept


def precompute_raw(entries):
    """For each image, precompute all post-NMS boxes at fixed low thresholds.
    Returns list of (truth, raw_boxes, sal_bounds, img_w, img_h)
    where raw_boxes = [(x,y,w,h,conf), ...] sorted by conf desc.
    """
    print(f"Precomputing YOLO detections on {len(entries)} images …")
    results = []
    for i, (truth, image_path, img_w, img_h) in enumerate(entries):
        if i % 50 == 0:
            print(f"  [{i}/{len(entries)}]")
        try:
            img = PILImage.open(image_path).convert("RGB")
            orig_w, orig_h = img.size
            lb, pad_left, pad_top, scale = _letterbox(np.array(img))
            x_in = lb.transpose(2, 0, 1)[None]
            out = _get_session().run(None, {"images": x_in})[0][0]  # [5, 8400]
            cx, cy, w, h, conf_raw = out[0], out[1], out[2], out[3], out[4]

            # Use a very low threshold to preserve all boxes for threshold search
            mask = conf_raw >= YOLO_CONF_THRESH
            raw_boxes = []
            if mask.any():
                cx2, cy2, w2, h2, conf2 = cx[mask], cy[mask], w[mask], h[mask], conf_raw[mask]
                x1 = cx2 - w2/2; y1 = cy2 - h2/2; x2 = cx2 + w2/2; y2 = cy2 + h2/2
                boxes = np.stack([x1, y1, x2, y2], axis=1)
                # NMS with a loose threshold
                kept = _nms(boxes, conf2, 0.45)
                for k in kept:
                    xn = max(0.0, min(1.0, (float(boxes[k,0])-pad_left)/scale/orig_w))
                    yn = max(0.0, min(1.0, (float(boxes[k,1])-pad_top)/scale/orig_h))
                    wn = max(0.01, min(1.0-xn, (float(boxes[k,2])-float(boxes[k,0]))/scale/orig_w))
                    hn = max(0.01, min(1.0-yn, (float(boxes[k,3])-float(boxes[k,1]))/scale/orig_h))
                    raw_boxes.append((xn, yn, wn, hn, float(conf2[k])))
                raw_boxes.sort(key=lambda b: b[4], reverse=True)
        except Exception as e:
            print(f"  error on {image_path}: {e}")
            raw_boxes = []

        sal = _spectral_saliency_bounds(image_path)
        results.append((truth, raw_boxes, sal, img_w, img_h))

    print(f"Done. {sum(1 for _, b, _, _, _ in results if b)} / {len(results)} had YOLO detections.\n")
    return results


def compute_bounds(raw_boxes, sal, gate_conf, union_thresh, top_k):
    """Apply threshold settings to raw_boxes → final (x,y,w,h) bounds."""
    if not raw_boxes:
        return sal

    best_conf = raw_boxes[0][4]
    if best_conf < gate_conf:
        return sal

    valid = [(x,y,w,h) for x,y,w,h,c in raw_boxes[:top_k] if c >= union_thresh * best_conf]
    if not valid:
        valid = [raw_boxes[0][:4]]

    x1 = min(b[0] for b in valid)
    y1 = min(b[1] for b in valid)
    x2 = max(b[0]+b[2] for b in valid)
    y2 = max(b[1]+b[3] for b in valid)
    return (x1, y1, x2-x1, y2-y1)


def evaluate_settings(precomputed, gate_conf, union_thresh, top_k):
    """Evaluate a specific threshold combination across all paddings."""
    detected = []
    for truth, raw_boxes, sal, img_w, img_h in precomputed:
        b = compute_bounds(raw_boxes, sal, gate_conf, union_thresh, top_k)
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
            best_score = ms; best_pad = pad; best_r = mr; best_p = mp
    return best_score, best_pad, best_r, best_p


def main():
    json_path = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO_ROOT / "crop_training.json"
    raw = json.loads(json_path.read_text())
    entries_raw = raw if isinstance(raw, list) else list(raw.values())

    entries = []
    for entry in entries_raw:
        if isinstance(entry, dict):
            c = entry.get("crop", entry)
        else:
            continue
        if not isinstance(c, dict) or "x" not in c:
            continue
        url = entry.get("url", "")
        image_path = resolve_image(url, None, CACHE_DIR)
        if not image_path:
            continue
        truth = Crop(c["x"], c["y"], c["w"], c["h"])
        img_w, img_h = get_image_size(image_path)
        entries.append((truth, image_path, img_w, img_h))

    print(f"Loaded {len(entries)} images.\n")
    precomputed = precompute_raw(entries)

    # Current baseline
    BASELINE_GATE = 0.15
    BASELINE_UNION = 0.50
    BASELINE_TOPK = 1000  # effectively unlimited

    base_score, base_pad, base_r, base_p = evaluate_settings(
        precomputed, BASELINE_GATE, BASELINE_UNION, BASELINE_TOPK)
    print(f"BASELINE (gate={BASELINE_GATE}, union_thresh={BASELINE_UNION}, top_k=∞): "
          f"score={base_score:.4f}, recall={base_r:.4f}, prec={base_p:.4f}, pad={base_pad}\n")

    # Grid search
    gate_confs = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]
    union_thresholds = [0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]
    top_ks = [1, 2, 3, 5, 10, 1000]

    best_score = base_score
    best_params = (BASELINE_GATE, BASELINE_UNION, BASELINE_TOPK, base_pad, base_r, base_p)
    n_tested = 0

    for gate in gate_confs:
        for union_t in union_thresholds:
            for top_k in top_ks:
                s, pad, r, p = evaluate_settings(precomputed, gate, union_t, top_k)
                n_tested += 1
                if s > best_score:
                    best_score = s
                    best_params = (gate, union_t, top_k, pad, r, p)
                    print(f"  ★ New best: gate={gate}, union={union_t}, top_k={top_k}, "
                          f"pad={pad}, score={s:.4f}, recall={r:.4f}, prec={p:.4f}")

    print(f"\nTested {n_tested} combinations.")
    gate, union_t, top_k, pad, r, p = best_params
    delta = best_score - base_score
    sign = "+" if delta >= 0 else ""
    print(f"\nBest: gate={gate}, union_thresh={union_t}, top_k={top_k}, pad={pad}")
    print(f"  score={best_score:.4f}, recall={r:.4f}, precision={p:.4f}")
    print(f"  Δ vs baseline: {sign}{delta:.4f}")

    if delta > 0:
        print(f"\nRecommendation: update ImageCropper.m:")
        print(f"  YOLO_GATE_CONF      → {gate}")
        print(f"  union conf fraction → {union_t}")
        print(f"  top_k boxes         → {top_k}")
        print(f"  padding             → {pad}")


if __name__ == "__main__":
    main()
