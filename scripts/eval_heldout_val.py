#!/usr/bin/env python3
"""
Honest held-out comparison of old vs new subject-detection ONNX models.

Uses the exact val split written by retrain_from_cache.py
(/tmp/inat_finetune_local/images|labels/val) so the new model is never
evaluated on images it was trained on.

Uses "forced-YOLO" scoring (raw union of detections, no confidence gate, no
saliency fallback) to avoid the gate/fallback confound documented in past
tune sessions: the app's real fallback is Apple Vision saliency (unavailable
here), and tuning the gate threshold changes how often eval's spectral
saliency fallback fires, which is not comparable across models.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import Crop, bounds_to_crop, recall, precision, weighted_score
import eval_onnx_variants as e

VAL_DIR = Path("/tmp/inat_finetune_local")
PADDINGS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25, 0.30]


def load_val_entries():
    img_dir = VAL_DIR / "images/val"
    lbl_dir = VAL_DIR / "labels/val"
    entries = []
    for img_path in sorted(img_dir.glob("*.jpg")):
        lbl_path = lbl_dir / (img_path.stem + ".txt")
        if not lbl_path.is_file():
            continue
        line = lbl_path.read_text().strip()
        if not line:
            continue
        _, cx, cy, w, h = map(float, line.split())
        truth = Crop(cx - w / 2, cy - h / 2, w, h)
        entries.append((str(img_path), truth))
    return entries


def forced_union_detect(image_path: str, model_path: Path):
    dets = e._raw_detections(image_path, model_path)
    if not dets:
        return None  # no fallback -- this is "forced YOLO", not full pipeline
    return e.algo_union(dets, image_path)


def evaluate_model(entries, model_path: Path, label: str):
    detected = []
    n_none = 0
    for img_path, truth in entries:
        try:
            w, h = Image.open(img_path).size
        except Exception:
            continue
        b = forced_union_detect(img_path, model_path)
        if b is None:
            n_none += 1
            continue
        detected.append((truth, b, w, h))

    print(f"\n[{label}] detections: {len(detected)}/{len(entries)} (no-detection: {n_none})")
    best = None
    for pad in PADDINGS:
        preds = [bounds_to_crop(*b, pad, w, h) for _, b, w, h in detected]
        truths = [t for t, _, _, _ in detected]
        rs = [recall(p, t) for p, t in zip(preds, truths)]
        ps = [precision(p, t) for p, t in zip(preds, truths)]
        ss = [weighted_score(p, t) for p, t in zip(preds, truths)]
        n = len(ss)
        mr, mp, ms = sum(rs) / n, sum(ps) / n, sum(ss) / n
        if best is None or ms > best[3]:
            best = (pad, mr, mp, ms)
        print(f"  pad={pad:.2f}  recall={mr:.3f}  prec={mp:.3f}  score={ms:.3f}")
    print(f"  BEST: pad={best[0]:.2f}  recall={best[1]:.3f}  prec={best[2]:.3f}  score={best[3]:.3f}")
    return best


def main():
    entries = load_val_entries()
    print(f"Loaded {len(entries)} held-out val images (never seen during training)")

    old_path = Path("/tmp/yolov8n_baseline_backup.onnx")
    new_path = Path("ios/iNaturalistReactNative/yolov8n.onnx")

    old_best = evaluate_model(entries, old_path, "OLD (deployed before this session)")
    new_best = evaluate_model(entries, new_path, "NEW (retrained on 2502 images)")

    print("\n" + "=" * 60)
    print(f"OLD best score: {old_best[3]:.4f} (pad={old_best[0]:.2f})")
    print(f"NEW best score: {new_best[3]:.4f} (pad={new_best[0]:.2f})")
    delta = new_best[3] - old_best[3]
    print(f"Delta: {'+' if delta >= 0 else ''}{delta:.4f}")


if __name__ == "__main__":
    main()
