#!/usr/bin/env python3
"""Analyze brightness_log.json against measured full-image luminance to tune
TARGET_LUMINANCE / TOLERANCE_FACTOR in useAutoBrightnessForUri.ts.

Luminance is the average of 0.299R+0.587G+0.114B over a 64x64 downsample of
the full image, replicating measureAverageLuminance() in ImageCropper.m.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_brightness_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def measure_luminance(image_path: str) -> float:
    img = Image.open(image_path).convert("RGB").resize((64, 64), Image.BILINEAR)
    arr = np.asarray(img).astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    return float((0.299 * r + 0.587 * g + 0.114 * b).mean())


def current_adjustment(luminance: float, target: float = 0.45, tol: float = 0.15) -> float:
    adj = target / luminance
    if abs(adj - 1.0) < tol:
        return 1.0
    return max(0.4, min(3.0, adj))


def main() -> None:
    raw = json.loads((REPO_ROOT / "brightness_log_raw.json").read_text())
    print(f"Loaded {len(raw)} brightness labels\n")

    rows = []
    for e in raw:
        url = e["url"]
        label = e["brightness"]
        path = resolve_image(url, None, CACHE_DIR)
        if not path:
            print(f"  skip (no image): {url}")
            continue
        try:
            lum = measure_luminance(path)
        except Exception as exc:
            print(f"  skip (measure failed {exc}): {url}")
            continue
        rows.append((url, label, lum))

    print(f"\nResolved {len(rows)}/{len(raw)} images\n")
    print(f"{'url':<70} {'label':>7} {'lum':>7} {'implied_target':>15} {'cur_pred':>9}")
    implied_targets = []
    for url, label, lum in rows:
        implied = label * lum
        implied_targets.append(implied)
        cur_pred = current_adjustment(lum)
        short = url[-66:]
        print(f"{short:<70} {label:>7.3f} {lum:>7.3f} {implied:>15.3f} {cur_pred:>9.3f}")

    implied_targets = np.array(implied_targets)
    print(f"\nImplied TARGET_LUMINANCE stats: mean={implied_targets.mean():.3f} "
          f"median={np.median(implied_targets):.3f} std={implied_targets.std():.3f}")

    # Current-formula error
    labels = np.array([r[1] for r in rows])
    lums = np.array([r[2] for r in rows])
    cur_preds = np.array([current_adjustment(lm) for lm in lums])
    cur_mae = np.mean(np.abs(cur_preds - labels))
    print(f"\nCurrent formula (target=0.45, tol=0.15) MAE vs labels: {cur_mae:.4f}")

    # Sweep target luminance holding tol=0.15, and no-tolerance raw ratio too
    best = None
    for target in np.arange(0.20, 0.70, 0.01):
        for tol in [0.0, 0.05, 0.10, 0.15, 0.20, 0.25]:
            preds = np.array([current_adjustment(lm, target, tol) for lm in lums])
            mae = np.mean(np.abs(preds - labels))
            if best is None or mae < best[2]:
                best = (target, tol, mae)
    print(f"Best (target, tol) by grid search: target={best[0]:.2f} tol={best[1]:.2f} MAE={best[2]:.4f}")


if __name__ == "__main__":
    main()
