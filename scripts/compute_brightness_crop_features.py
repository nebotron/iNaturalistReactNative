#!/usr/bin/env python3
"""
Compute crop-region luminance features for every image in
brightness_log_raw.json, using the deployed subject detector to find the
crop (same as production: brightness is measured over the detected subject
region, not the full frame). Writes /tmp/brightness_crop_features.json for
scripts/explore_brightness_crop_models.py to consume.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from evaluate_subject_detector import resolve_image
from eval_onnx_variants import MODELS, _raw_detections, algo_union

REPO_ROOT = Path(__file__).parent.parent
CACHE_DIR = Path("/tmp/inat_brightness_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)
DEPLOYED_MODEL = MODELS["yolov8n_current"]


def detect_bounds_deployed(image_path: str) -> tuple[float, float, float, float] | None:
    """Same model + algorithm (union) as production ImageCropper.m."""
    dets = _raw_detections(image_path, DEPLOYED_MODEL)
    return algo_union(dets, image_path)


def crop_features(image_path: str, bounds: tuple[float, float, float, float] | None) -> dict:
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    if bounds is not None:
        bx, by, bw, bh = bounds
        left, top = bx * w, by * h
        right, bottom = left + bw * w, top + bh * h
    else:
        left, top, right, bottom = 0, 0, w, h
    left, top = max(0, left), max(0, top)
    right, bottom = min(w, right), min(h, bottom)
    if right - left < 2 or bottom - top < 2:
        left, top, right, bottom = 0, 0, w, h

    crop = img.crop((left, top, right, bottom)).resize((64, 64), Image.BILINEAR)
    arr = np.asarray(crop).astype(np.float32) / 255.0
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    lum = (0.299 * r + 0.587 * g + 0.114 * b).flatten()

    return {
        "mean": float(lum.mean()),
        "geomean": float(np.exp(np.log(np.clip(lum, 1e-4, None)).mean())),
        "median": float(np.median(lum)),
        "std": float(lum.std()),
        "p10": float(np.percentile(lum, 10)),
        "p25": float(np.percentile(lum, 25)),
        "p75": float(np.percentile(lum, 75)),
        "p90": float(np.percentile(lum, 90)),
        "frac_dark": float((lum < 0.15).mean()),
        "frac_bright": float((lum > 0.85).mean()),
    }


def main() -> None:
    raw = json.loads((REPO_ROOT / "brightness_log_raw.json").read_text())
    print(f"Loaded {len(raw)} brightness labels")

    rows = []
    for e in raw:
        url = e["url"]
        label = e["brightness"]
        path = resolve_image(url, None, CACHE_DIR)
        if not path:
            print(f"  skip (no image): {url}")
            continue
        bounds = detect_bounds_deployed(path)
        try:
            feats = crop_features(path, bounds)
        except Exception as exc:
            print(f"  skip (measure failed {exc}): {url}")
            continue
        feats["label"] = label
        feats["url"] = url
        feats["had_detection"] = bounds is not None
        rows.append(feats)

    print(f"Resolved {len(rows)}/{len(raw)} images "
          f"({sum(r['had_detection'] for r in rows)} with a detected crop)")

    out_path = Path("/tmp/brightness_crop_features.json")
    out_path.write_text(json.dumps(rows, indent=2))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
