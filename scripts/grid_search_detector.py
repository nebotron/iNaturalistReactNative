#!/usr/bin/env python3
"""
Grid search over ONNX detector parameters plus ensemble/intersection strategies.

Searches:
  gate_conf:  0.05, 0.08, 0.10, 0.12, 0.15
  union_frac: 0.25, 0.30, 0.35, 0.40, 0.45, 0.50

Also tests:
  intersect_saliency  — intersect YOLO union-box with saliency when both fire
  ensemble_intersect  — intersect base-model and finetuned-model union boxes
  top1                — use only the highest-confidence YOLO detection (no union)

Usage:
    python3 scripts/grid_search_detector.py crop_training.json \
        --cache-dir /tmp/inat_eval_cache_v2
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    Crop, bounds_to_crop, recall, precision, weighted_score,
    resolve_image, get_image_size,
    _letterbox, _get_onnx_session,
    _ONNX_CONF_THRESH, _ONNX_IOU_THRESH, _ONNX_INPUT_SIZE,
    _spectral_saliency_bounds,
)

REPO_ROOT = Path(__file__).parent.parent
DEFAULT_MODEL    = str(REPO_ROOT / "ios" / "iNaturalistReactNative" / "yolov8n.onnx")
FINETUNED_MODEL  = str(REPO_ROOT / "ios" / "iNaturalistReactNative" / "yolov8n_finetuned.onnx")

PADDINGS     = [0.00, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]
GATE_VALUES  = [0.05, 0.08, 0.10, 0.12, 0.15]
UNION_VALUES = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50]


# ---------------------------------------------------------------------------
# Raw detections (NMS but no gate/union, returns list of (x1,y1,x2,y2,conf))
# ---------------------------------------------------------------------------

def _raw_dets(image_path: str, model_path: str):
    import cv2, numpy as np
    img = cv2.imread(image_path)
    if img is None:
        return None, None, None, None, None
    img_h, img_w = img.shape[:2]
    canvas, pad_left, pad_top, scale = _letterbox(img)
    rgb = canvas[:, :, ::-1].astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[np.newaxis])
    sess = _get_onnx_session(model_path)
    out = sess.run(None, {"images": tensor})[0][0]  # [5, 8400]

    dets = []
    for j in range(out.shape[1]):
        conf = float(out[4, j])
        if conf < _ONNX_CONF_THRESH:
            continue
        cx, cy, bw, bh = float(out[0,j]), float(out[1,j]), float(out[2,j]), float(out[3,j])
        dets.append((cx - bw/2, cy - bh/2, cx + bw/2, cy + bh/2, conf))

    # greedy NMS
    dets_s = sorted(dets, key=lambda d: d[4], reverse=True)
    suppressed = [False] * len(dets_s)
    kept = []
    for i, d in enumerate(dets_s):
        if suppressed[i]:
            continue
        kept.append(dets_s[i])
        for j in range(i + 1, len(dets_s)):
            if suppressed[j]:
                continue
            ix1 = max(d[0], dets_s[j][0]); iy1 = max(d[1], dets_s[j][1])
            ix2 = min(d[2], dets_s[j][2]); iy2 = min(d[3], dets_s[j][3])
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            a1 = (d[2]-d[0])*(d[3]-d[1]); a2 = (dets_s[j][2]-dets_s[j][0])*(dets_s[j][3]-dets_s[j][1])
            iou_v = inter / (a1 + a2 - inter + 1e-8)
            if iou_v > _ONNX_IOU_THRESH:
                suppressed[j] = True

    return kept, pad_left, pad_top, scale, (img_w, img_h)


def _box_to_norm(x1, y1, x2, y2, pad_left, pad_top, scale, img_w, img_h):
    x = max(0.0, min(1.0, (x1 - pad_left) / scale / img_w))
    y = max(0.0, min(1.0, (y1 - pad_top)  / scale / img_h))
    w = max(0.01, min(1.0 - x, (x2 - x1) / scale / img_w))
    h = max(0.01, min(1.0 - y, (y2 - y1) / scale / img_h))
    return (x, y, w, h)


def _apply_gate_union(kept, gate, union_frac, pad_left, pad_top, scale, img_w, img_h):
    """Apply gate + union logic to NMS-kept detections."""
    if not kept:
        return None
    best_conf = kept[0][4]
    if best_conf < gate:
        return None
    thresh = union_frac * best_conf
    ux1, uy1, ux2, uy2 = 1e9, 1e9, -1e9, -1e9
    used = 0
    for d in kept:
        if d[4] < thresh:
            continue
        ux1 = min(ux1, d[0]); uy1 = min(uy1, d[1])
        ux2 = max(ux2, d[2]); uy2 = max(uy2, d[3])
        used += 1
    if used == 0:
        ux1, uy1, ux2, uy2 = kept[0][:4]
    return _box_to_norm(ux1, uy1, ux2, uy2, pad_left, pad_top, scale, img_w, img_h)


CENTER_FALLBACK = (0.2, 0.2, 0.6, 0.6)

def _saliency_or_center(image_path):
    sal = _spectral_saliency_bounds(image_path)
    if sal is not None and sal[2] <= 0.6 and sal[3] <= 0.6:
        return sal
    return CENTER_FALLBACK


# ---------------------------------------------------------------------------
# Precompute per-image detections for both models
# ---------------------------------------------------------------------------

def precompute(entries, cache_dir):
    import cv2  # noqa: ensure available
    results = []
    print(f"Precomputing detections for {len(entries)} images …")
    for i, (image_path, img_w, img_h, truth) in enumerate(entries, 1):
        base_dets  = _raw_dets(image_path, DEFAULT_MODEL)
        fine_dets  = _raw_dets(image_path, FINETUNED_MODEL)
        sal        = _spectral_saliency_bounds(image_path)
        results.append((image_path, img_w, img_h, truth, base_dets, fine_dets, sal))
        if i % 50 == 0:
            print(f"  {i}/{len(entries)}")
    print(f"  done ({len(results)} images).")
    return results


# ---------------------------------------------------------------------------
# Score a set of predictions against ground truth at a given padding
# ---------------------------------------------------------------------------

def score_predictions(preds, truths, padding, img_sizes):
    scores = []
    for (pred, truth, (iw, ih)) in zip(preds, truths, img_sizes):
        c = bounds_to_crop(*pred, padding, iw, ih)
        scores.append(weighted_score(c, truth))
    return sum(scores) / len(scores) if scores else 0.0


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("json_file", nargs="?", default="crop_training.json")
    ap.add_argument("--cache-dir", default="/tmp/inat_eval_cache_v2")
    args = ap.parse_args()

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    with open(args.json_file) as f:
        raw = json.load(f)
    print(f"Loaded {len(raw)} entries.")

    # Download / resolve images
    entries = []
    skipped = 0
    for entry in raw:
        url = entry["url"]
        truth = Crop(entry["x"], entry["y"], entry["w"], entry["h"])
        image_path = resolve_image(url, None, cache_dir)
        if not image_path:
            skipped += 1
            continue
        iw, ih = get_image_size(image_path)
        entries.append((image_path, iw, ih, truth))

    print(f"Using {len(entries)} images (skipped {skipped}).\n")

    # Precompute detections
    precomp = precompute(entries, cache_dir)

    truths    = [e[3] for e in precomp]
    img_sizes = [(e[1], e[2]) for e in precomp]

    # -----------------------------------------------------------------------
    # Grid search: gate × union_frac × padding (base model)
    # -----------------------------------------------------------------------

    print("\n" + "="*70)
    print("GRID SEARCH — base model (gate × union_frac)")
    print("="*70)
    print(f"  {'gate':>6}  {'union':>6}  {'pad':>5}  {'score':>7}  {'recall':>7}  {'prec':>7}")
    print("  " + "-"*52)

    best_grid = {"score": -1}
    for gate in GATE_VALUES:
        for ufrac in UNION_VALUES:
            # build predictions for each image
            preds = []
            for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
                kept, pl, pt, sc, (bw, bh) = base_dets
                det = _apply_gate_union(kept, gate, ufrac, pl, pt, sc, bw, bh)
                if det is None:
                    det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
                preds.append(det)

            # find best padding
            for pad in PADDINGS:
                crops = [bounds_to_crop(*p, pad, iw, ih) for p, (iw, ih) in zip(preds, img_sizes)]
                sc_val = sum(weighted_score(c, t) for c, t in zip(crops, truths)) / len(crops)
                rc_val = sum(recall(c, t)          for c, t in zip(crops, truths)) / len(crops)
                pr_val = sum(precision(c, t)       for c, t in zip(crops, truths)) / len(crops)
                if sc_val > best_grid["score"]:
                    best_grid = {"score": sc_val, "gate": gate, "union": ufrac,
                                 "pad": pad, "recall": rc_val, "prec": pr_val}

            # print best pad for this gate/union pair
            best_pad_score = max(
                (sum(weighted_score(
                    bounds_to_crop(*p, pad, iw, ih), t)
                    for p, t, (iw, ih) in zip(preds, truths, img_sizes)) / len(preds),
                 pad)
                for pad in PADDINGS
            )
            bsc, bpad = best_pad_score
            brc = sum(recall(bounds_to_crop(*p, bpad, iw, ih), t)
                      for p, t, (iw, ih) in zip(preds, truths, img_sizes)) / len(preds)
            bpr = sum(precision(bounds_to_crop(*p, bpad, iw, ih), t)
                      for p, t, (iw, ih) in zip(preds, truths, img_sizes)) / len(preds)
            marker = " ★" if bsc > 0.824 else ""
            print(f"  {gate:>6.2f}  {ufrac:>6.2f}  {bpad:>5.2f}  {bsc:>7.3f}  {brc:>7.3f}  {bpr:>7.3f}{marker}")

    print(f"\n  Best: gate={best_grid['gate']:.2f}, union={best_grid['union']:.2f}, "
          f"pad={best_grid['pad']:.2f}  →  score={best_grid['score']:.3f} "
          f"(recall={best_grid['recall']:.3f}, prec={best_grid['prec']:.3f})")

    # -----------------------------------------------------------------------
    # Algorithmic variants
    # -----------------------------------------------------------------------

    FIXED_GATE  = best_grid["gate"]
    FIXED_UNION = best_grid["union"]

    print("\n" + "="*70)
    print("ALGORITHM VARIANTS (at best gate/union params)")
    print("="*70)

    variants = {}

    # 1. Baseline (best grid params, already computed above)
    preds_base = []
    for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
        kept, pl, pt, sc, (bw, bh) = base_dets
        det = _apply_gate_union(kept, FIXED_GATE, FIXED_UNION, pl, pt, sc, bw, bh)
        if det is None:
            det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
        preds_base.append(det)
    variants["base_best_params"] = preds_base

    # 2. Intersect YOLO union-box with saliency when both fire
    def intersect_rects(a, b):
        ax, ay, aw, ah = a; bx, by, bw, bh = b
        ix = max(ax, bx); iy = max(ay, by)
        iw = min(ax+aw, bx+bw) - ix
        ih = min(ay+ah, by+bh) - iy
        if iw <= 0.01 or ih <= 0.01:
            return None
        return (ix, iy, iw, ih)

    preds_intersect = []
    for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
        kept, pl, pt, sc, (bw, bh) = base_dets
        det = _apply_gate_union(kept, FIXED_GATE, FIXED_UNION, pl, pt, sc, bw, bh)
        if det is None:
            det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
        elif sal is not None:
            isect = intersect_rects(det, sal)
            if isect and isect[2] >= 0.05 and isect[3] >= 0.05:
                det = isect
        preds_intersect.append(det)
    variants["yolo_intersect_saliency"] = preds_intersect

    # 3. Top-1 only (no union, just best detection)
    preds_top1 = []
    for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
        kept, pl, pt, sc, (bw, bh) = base_dets
        det = None
        if kept and kept[0][4] >= FIXED_GATE:
            det = _box_to_norm(*kept[0][:4], pl, pt, sc, bw, bh)
        if det is None:
            det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
        preds_top1.append(det)
    variants["top1_detection"] = preds_top1

    # 4. Ensemble: intersect base + finetuned union boxes when both fire
    preds_ensemble = []
    for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
        kept_b, pl_b, pt_b, sc_b, (bw_b, bh_b) = base_dets
        kept_f, pl_f, pt_f, sc_f, (bw_f, bh_f) = fine_dets
        det_b = _apply_gate_union(kept_b, FIXED_GATE, FIXED_UNION, pl_b, pt_b, sc_b, bw_b, bh_b)
        det_f = _apply_gate_union(kept_f, FIXED_GATE, FIXED_UNION, pl_f, pt_f, sc_f, bw_f, bh_f)
        if det_b and det_f:
            isect = intersect_rects(det_b, det_f)
            det = isect if isect else det_b
        elif det_b:
            det = det_b
        elif det_f:
            det = det_f
        else:
            det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
        preds_ensemble.append(det)
    variants["ensemble_base_finetuned"] = preds_ensemble

    # 5. Finetuned model alone (with best params)
    preds_ft = []
    for (ip, iw, ih, truth, base_dets, fine_dets, sal) in precomp:
        kept, pl, pt, sc, (bw, bh) = fine_dets
        det = _apply_gate_union(kept, FIXED_GATE, FIXED_UNION, pl, pt, sc, bw, bh)
        if det is None:
            det = (sal if sal and sal[2] <= 0.6 and sal[3] <= 0.6 else CENTER_FALLBACK)
        preds_ft.append(det)
    variants["finetuned_best_params"] = preds_ft

    # Evaluate all variants
    print(f"\n  {'Algorithm':<30}  {'BestPad':>7}  {'Score':>7}  {'Recall':>7}  {'Prec':>7}")
    print("  " + "-"*66)

    variant_results = {}
    for name, preds in variants.items():
        best_sc, best_pad_v = -1, PADDINGS[0]
        best_rc, best_pr = 0, 0
        for pad in PADDINGS:
            crops = [bounds_to_crop(*p, pad, iw, ih) for p, (iw, ih) in zip(preds, img_sizes)]
            sc = sum(weighted_score(c, t) for c, t in zip(crops, truths)) / len(crops)
            rc = sum(recall(c, t)         for c, t in zip(crops, truths)) / len(crops)
            pr = sum(precision(c, t)      for c, t in zip(crops, truths)) / len(crops)
            if sc > best_sc:
                best_sc, best_pad_v, best_rc, best_pr = sc, pad, rc, pr
        variant_results[name] = (best_sc, best_pad_v, best_rc, best_pr)
        marker = " ★" if best_sc > 0.824 else ""
        print(f"  {name:<30}  {best_pad_v:>7.2f}  {best_sc:>7.3f}  {best_rc:>7.3f}  {best_pr:>7.3f}{marker}")

    print()
    overall_best_name = max(variant_results, key=lambda n: variant_results[n][0])
    overall_best = variant_results[overall_best_name]
    print(f"Overall best: {overall_best_name}  "
          f"score={overall_best[0]:.3f}  "
          f"pad={overall_best[1]:.2f}  "
          f"recall={overall_best[2]:.3f}  "
          f"prec={overall_best[3]:.3f}")


if __name__ == "__main__":
    main()
