#!/usr/bin/env python3
"""
Experiment with alternative subject-detection algorithm variants and compare them
against the existing "improved" baseline (yolov8n, saliency fallback).

Algorithms tested:
  baseline    — yolov8n, union of human/animal detections, saliency fallback
  algo_top1   — yolov8n, highest-confidence single detection, saliency fallback
  algo_smallest  — yolov8n, smallest-area detection, saliency fallback
  algo_saliency_intersect — yolov8n, intersection of detection-union with saliency
  algo_center_biased — yolov8n, detection whose center is closest to image center
  yolov8s     — yolov8s model (larger), union of human/animal detections, saliency fallback

Usage:
    python3 scripts/experiment_algorithms.py
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Import helpers from the sibling evaluate_subject_detector module
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import (
    Crop,
    bounds_to_crop,
    clamp_crop,
    intersection_area,
    recall,
    precision,
    weighted_score,
    _union_boxes,
    _spectral_saliency_bounds,
    _run_yolo,
    _get_yolo,
    _YOLO_MIN_CONF,
    _YOLO_PERSON_CLASS,
    _YOLO_ANIMAL_CLASSES,
    _load_env,
    _fetch_firebase,
    resolve_image,
    get_image_size,
    inaturalist_original_url,
    download_image,
)

# ---------------------------------------------------------------------------
# Persistent cache directory
# ---------------------------------------------------------------------------

CACHE_DIR = Path("/tmp/inat_eval_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# Padding grid (same as evaluate_subject_detector.py)
# ---------------------------------------------------------------------------

PADDINGS = [0.00, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]

# ---------------------------------------------------------------------------
# yolov8s model loader — mirrors _get_yolo() but loads the "s" variant
# ---------------------------------------------------------------------------

_yolo_s_model = None


def _get_yolo_s():
    global _yolo_s_model
    if _yolo_s_model is None:
        try:
            from ultralytics import YOLO  # type: ignore[import]
            _yolo_s_model = YOLO("yolov8s.pt")
        except ImportError:
            sys.exit(
                "ultralytics is required.\n"
                "  pip install ultralytics\n"
            )
    return _yolo_s_model


def _run_yolo_s(image_path: str) -> list:
    """Same as _run_yolo but uses yolov8s."""
    model = _get_yolo_s()
    results = model(image_path, verbose=False)[0]
    object_boxes = []
    for box in results.boxes:
        cls = int(box.cls)
        conf = float(box.conf)
        if conf < _YOLO_MIN_CONF:
            continue
        if cls != _YOLO_PERSON_CLASS and cls not in _YOLO_ANIMAL_CLASSES:
            continue
        x1, y1, x2, y2 = [float(v) for v in box.xyxyn[0]]
        object_boxes.append((x1, y1, x2 - x1, y2 - y1, conf))
    return object_boxes


# ---------------------------------------------------------------------------
# New algorithm implementations
# ---------------------------------------------------------------------------

def _run_yolo_with_conf(image_path: str) -> list[tuple[float, float, float, float, float]]:
    """Like _run_yolo but also returns confidence as 5th element."""
    model = _get_yolo()
    results = model(image_path, verbose=False)[0]
    boxes_with_conf = []
    for box in results.boxes:
        cls = int(box.cls)
        conf = float(box.conf)
        if conf < _YOLO_MIN_CONF:
            continue
        if cls != _YOLO_PERSON_CLASS and cls not in _YOLO_ANIMAL_CLASSES:
            continue
        x1, y1, x2, y2 = [float(v) for v in box.xyxyn[0]]
        boxes_with_conf.append((x1, y1, x2 - x1, y2 - y1, conf))
    return boxes_with_conf


def algo_top1(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """Highest-confidence single detection; saliency fallback."""
    boxes = _run_yolo_with_conf(image_path)
    if boxes:
        best = max(boxes, key=lambda b: b[4])
        return best[:4]
    return _spectral_saliency_bounds(image_path)


def algo_smallest(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """Smallest-area detection box; saliency fallback."""
    boxes = _run_yolo_with_conf(image_path)
    if boxes:
        smallest = min(boxes, key=lambda b: b[2] * b[3])
        return smallest[:4]
    return _spectral_saliency_bounds(image_path)


def algo_saliency_intersect(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Intersection of (union of detections) with saliency bounding box.
    Falls back to detection union if the intersection is < 25% of the detection-union area.
    Falls back to pure saliency if no detections.
    """
    boxes = _run_yolo(image_path)
    sal = _spectral_saliency_bounds(image_path)

    if not boxes:
        return sal  # no detections — use saliency (may be None)

    det_union = _union_boxes(boxes)
    if det_union is None:
        return sal

    if sal is None:
        return det_union

    # Compute intersection of det_union and saliency boxes
    du = Crop(*det_union)
    sb = Crop(*sal)
    inter = intersection_area(du, sb)
    det_area = du.w * du.h

    if det_area > 0 and inter / det_area >= 0.25:
        # Return the intersection box
        ix1 = max(du.x, sb.x)
        iy1 = max(du.y, sb.y)
        ix2 = min(du.x + du.w, sb.x + sb.w)
        iy2 = min(du.y + du.h, sb.y + sb.h)
        if ix2 > ix1 and iy2 > iy1:
            return (ix1, iy1, ix2 - ix1, iy2 - iy1)

    # Intersection is too tight — fall back to detection union
    return det_union


def algo_center_biased(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """Detection whose center is closest to image center (0.5, 0.5); saliency fallback."""
    boxes = _run_yolo_with_conf(image_path)
    if boxes:
        def dist_to_center(b):
            cx = b[0] + b[2] / 2
            cy = b[1] + b[3] / 2
            return (cx - 0.5) ** 2 + (cy - 0.5) ** 2

        closest = min(boxes, key=dist_to_center)
        return closest[:4]
    return _spectral_saliency_bounds(image_path)


def algo_baseline(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """Baseline: yolov8n union of detections, saliency fallback (= improved algorithm)."""
    boxes = _run_yolo(image_path)
    if boxes:
        return _union_boxes(boxes)
    return _spectral_saliency_bounds(image_path)


def algo_yolov8s(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """yolov8s model, union of detections, saliency fallback."""
    boxes_with_conf = _run_yolo_s(image_path)
    boxes = [b[:4] for b in boxes_with_conf]
    if boxes:
        return _union_boxes(boxes)
    return _spectral_saliency_bounds(image_path)


# ---------------------------------------------------------------------------
# Evaluation helpers
# ---------------------------------------------------------------------------

ALGORITHMS = [
    ("baseline",              algo_baseline),
    ("algo_top1",             algo_top1),
    ("algo_smallest",         algo_smallest),
    ("algo_saliency_intersect", algo_saliency_intersect),
    ("algo_center_biased",    algo_center_biased),
    ("yolov8s",               algo_yolov8s),
]


@dataclass
class ImageEntry:
    key: str
    truth: Crop
    image_path: str
    image_width: int
    image_height: int
    # Detected bounds per algorithm (None = no detection)
    bounds: dict = field(default_factory=dict)


@dataclass
class AlgoResult:
    name: str
    best_padding: float
    best_recall: float
    best_precision: float
    best_score: float


def evaluate_algo(entries: list[ImageEntry], algo_name: str, paddings: list[float]) -> AlgoResult:
    detected = [e for e in entries if e.bounds.get(algo_name) is not None]
    n = len(detected)

    best_padding = paddings[0]
    best_score = -1.0
    best_recall_at_best = 0.0
    best_precision_at_best = 0.0

    for pad in paddings:
        preds = [
            bounds_to_crop(*e.bounds[algo_name], pad, e.image_width, e.image_height)
            for e in detected
        ]
        recalls = [recall(p, e.truth) for p, e in zip(preds, detected)]
        precisions = [precision(p, e.truth) for p, e in zip(preds, detected)]
        scores = [weighted_score(p, e.truth) for p, e in zip(preds, detected)]

        mean_s = sum(scores) / n if n else 0.0
        mean_r = sum(recalls) / n if n else 0.0
        mean_p = sum(precisions) / n if n else 0.0

        if mean_s > best_score:
            best_score = mean_s
            best_padding = pad
            best_recall_at_best = mean_r
            best_precision_at_best = mean_p

    return AlgoResult(
        name=algo_name,
        best_padding=best_padding,
        best_recall=best_recall_at_best,
        best_precision=best_precision_at_best,
        best_score=best_score,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    _load_env()
    base_url = os.environ.get("CROP_LOG_FIREBASE_URL", "").strip()
    if not base_url:
        sys.exit(
            "CROP_LOG_FIREBASE_URL is not set.\n"
            "Add it to .env in the project root."
        )

    raw = _fetch_firebase(base_url)

    # Support both list format (Firebase/crop_training.json) and keyed-object format
    if isinstance(raw, list):
        entries_raw = [(entry["url"], entry) for entry in raw]
    else:
        entries_raw = [
            (key, val["crop"]) for key, val in raw.items()
            if val.get("crop") is not None
        ]

    print(f"Loaded {len(entries_raw)} entries with crop data.\n")

    # ---- Download / resolve images, collect ground-truth ----
    image_entries: list[ImageEntry] = []
    skipped = 0

    for i, (key, crop_data) in enumerate(entries_raw, 1):
        # crop_data may be the full entry (list format) or just the crop sub-dict
        if "crop" in crop_data:
            c = crop_data["crop"]
        else:
            c = crop_data
        truth = Crop(c["x"], c["y"], c["w"], c["h"])

        short_key = key[-60:] if len(key) > 60 else key
        print(f"[{i}/{len(entries_raw)}] {short_key}")

        image_path = resolve_image(key, None, CACHE_DIR)
        if not image_path:
            print("  image not found, skipping")
            skipped += 1
            continue

        img_w, img_h = get_image_size(image_path)
        image_entries.append(ImageEntry(
            key=key,
            truth=truth,
            image_path=image_path,
            image_width=img_w,
            image_height=img_h,
        ))

    if skipped:
        print(f"\nSkipped {skipped} entries (image not found).")
    if not image_entries:
        sys.exit("No images could be evaluated.")

    # ---- Run all algorithms ----
    print(f"\nRunning {len(ALGORITHMS)} algorithms on {len(image_entries)} images …\n")

    for algo_name, algo_fn in ALGORITHMS:
        print(f"  [{algo_name}]")
        for entry in image_entries:
            try:
                bounds = algo_fn(entry.image_path)
            except Exception as exc:
                print(f"    ERROR on {entry.key[-40:]}: {exc}")
                bounds = None
            entry.bounds[algo_name] = bounds
        n_detected = sum(1 for e in image_entries if e.bounds[algo_name] is not None)
        print(f"    Detected: {n_detected}/{len(image_entries)}")

    # ---- Evaluate across padding grid ----
    print(f"\nEvaluating across paddings: {PADDINGS}\n")

    results: list[AlgoResult] = []
    for algo_name, _ in ALGORITHMS:
        result = evaluate_algo(image_entries, algo_name, PADDINGS)
        results.append(result)

    # ---- Sort by best_score descending ----
    results.sort(key=lambda r: r.best_score, reverse=True)

    # ---- Summary table ----
    col_w = 26
    print("=" * 80)
    print("RESULTS — sorted by best weighted score (2*recall + 1*precision) / 3")
    print("=" * 80)
    print(f"  {'Algorithm':<{col_w}}  {'Best Padding':>12}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}")
    print("  " + "-" * 68)
    for r in results:
        print(f"  {r.name:<{col_w}}  {r.best_padding:>12.2f}  "
              f"{r.best_recall:>8.3f}  {r.best_precision:>10.3f}  {r.best_score:>7.3f}")
    print("=" * 80)
    winner = results[0]
    print(f"\nBest algorithm: {winner.name}  "
          f"(padding={winner.best_padding}, recall={winner.best_recall:.3f}, "
          f"precision={winner.best_precision:.3f}, score={winner.best_score:.3f})")
    print()


if __name__ == "__main__":
    main()
