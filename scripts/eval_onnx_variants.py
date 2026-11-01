#!/usr/bin/env python3
"""
Evaluate multiple ONNX model variants on crop_training.json.

Tests ios/iNaturalistReactNative/yolov8n.onnx (the deployed, finetuned
single-class model); add other .onnx files to MODELS to compare them.

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
    Crop, bounds_to_crop, recall, precision, crop_score,
    _spectral_saliency_bounds, intersection_area,
    resolve_image, get_image_size,
)
import cache_detections

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

PADDINGS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]

# Post-processing constants (matching ImageCropper.m); inference and fusion
# live in cache_detections.py
YOLO_GATE_CONF = 0.0
YOLO_UNION_THRESH = 0.60
YOLO_UNION_MAX_K = 1

MODELS = {
    "yolov8n_current":   REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx",
}


_sessions: dict[str, ort.InferenceSession] = {}


def _get_session(model_path: Path) -> ort.InferenceSession:
    key = str(model_path)
    if key not in _sessions:
        _sessions[key] = ort.InferenceSession(key)
    return _sessions[key]


_det_cache: dict[tuple[str, str], list] = {}


def _raw_detections(image_path: str, model_path: Path) -> list[tuple[float, float, float, float, float]]:
    """Returns (x,y,w,h,conf) list in normalized image coords, sorted by conf desc."""
    ck = (image_path, str(model_path))
    if ck in _det_cache:
        return _det_cache[ck]
    dets = _raw_detections_uncached(image_path, model_path)
    _det_cache[ck] = dets
    return dets


def _raw_detections_uncached(image_path: str, model_path: Path) -> list[tuple[float, float, float, float, float]]:
    """The app's detections: three views fused (see cache_detections.VIEWS)."""
    try:
        img = PILImage.open(image_path).convert("RGB")
        orig_w, orig_h = img.size
        img_arr = np.array(img)
    except Exception:
        return []
    cache_detections._sess = _get_session(model_path)
    dets = cache_detections._detect_array(img_arr, orig_w, orig_h)
    if not len(dets) or dets[0, 4] < YOLO_GATE_CONF:
        return []
    return [tuple(map(float, d)) for d in dets]


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
        ss = [crop_score(p, t) for p, t in zip(preds, truths)]
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
        if not isinstance(c, dict) or any(k not in c for k in ("x", "y", "w", "h")):
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
    print("RESULTS — sorted by score (IoU with the chosen crop)")
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
