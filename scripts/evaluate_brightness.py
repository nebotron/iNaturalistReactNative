#!/usr/bin/env python3
"""
Evaluate and tune the iNaturalist auto-brightness algorithm.

Fetches brightness labels from Firebase (brightness_log.json alongside crop_log.json),
downloads images, measures perceptual luminance in the labeled crop region, and evaluates
how well the computeAdjustment() function matches the manually-labeled brightness values.

Score metric (lower is better):
  MAE  = mean |computed_adjustment - labeled_adjustment|
  RMSE = sqrt(mean (computed - labeled)^2)

When no Firebase URL is set or Firebase is unreachable, falls back to analyzing the
luminance distribution of crop_training.json images to characterise the algorithm's
behaviour on real iNat images.

Usage:
    python3 scripts/evaluate_brightness.py
    python3 scripts/evaluate_brightness.py --cache-dir /tmp/brightness_cache
    python3 scripts/evaluate_brightness.py --no-firebase  # distribution analysis only

Set CROP_LOG_FIREBASE_URL in .env or as an environment variable.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import urllib.request
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).parent.parent
_ENV_FILE = REPO_ROOT / ".env"
_DEFAULT_FIREBASE_URL = "https://inaturalist-9001d-default-rtdb.firebaseio.com"

# Mirror the TypeScript constants from useAutoBrightnessForUri.ts
DEFAULT_TARGET_LUMINANCE = 0.45
DEFAULT_TOLERANCE_FACTOR = 0.15
DEFAULT_CLAMP_MIN = 0.4
DEFAULT_CLAMP_MAX = 3.0

CACHE_DIR_DEFAULT = Path("/tmp/inat_brightness_cache")

# ─── Luminance measurement (mirrors ImageCropper.m measureAverageLuminance) ──

def measure_luminance(image_path: str,
                      crop: Optional[dict] = None,
                      sample_size: int = 64) -> Optional[float]:
    """
    Compute average perceptual luminance (BT.601) in a normalised crop region.
    Matches the iOS measureAverageLuminance() function exactly.

    crop: dict with keys x, y, w, h (normalised [0,1] top-left coords), or None for full image.
    Returns float in [0,1] or None on error.
    """
    try:
        from PIL import Image as PILImage
    except ImportError:
        sys.exit("Pillow is required: pip install Pillow")
    try:
        img = PILImage.open(image_path).convert("RGB")
    except Exception as e:
        print(f"  Cannot open {image_path}: {e}")
        return None

    orig_w, orig_h = img.size

    if crop:
        # Crop to the region and scale to sample_size×sample_size
        x0 = int(crop["x"] * orig_w)
        y0 = int(crop["y"] * orig_h)
        x1 = int((crop["x"] + crop["w"]) * orig_w)
        y1 = int((crop["y"] + crop["h"]) * orig_h)
        # Clamp to image bounds
        x0 = max(0, min(x0, orig_w - 1))
        y0 = max(0, min(y0, orig_h - 1))
        x1 = max(x0 + 1, min(x1, orig_w))
        y1 = max(y0 + 1, min(y1, orig_h))
        region = img.crop((x0, y0, x1, y1))
    else:
        region = img

    scaled = region.resize((sample_size, sample_size), PILImage.BILINEAR)
    pixels = list(scaled.getdata())

    total = 0.0
    for r, g, b in pixels:
        # BT.601 luminance weights (matches iOS code: 0.299R + 0.587G + 0.114B)
        total += 0.299 * r + 0.587 * g + 0.114 * b
    return total / (255.0 * sample_size * sample_size)


# ─── computeAdjustment (mirrors useAutoBrightnessForUri.ts) ──────────────────

def compute_adjustment(
    luminance: float,
    target: float = DEFAULT_TARGET_LUMINANCE,
    tolerance: float = DEFAULT_TOLERANCE_FACTOR,
    clamp_min: float = DEFAULT_CLAMP_MIN,
    clamp_max: float = DEFAULT_CLAMP_MAX,
) -> float:
    adj = target / luminance
    if abs(adj - 1.0) < tolerance:
        return 1.0
    return max(clamp_min, min(clamp_max, adj))


# ─── Image download helpers ───────────────────────────────────────────────────

def _normalize_url(url: str) -> str:
    """Map any iNat photo URL to the 'large' size on S3."""
    import re
    # Prefer S3 over static.inaturalist.org
    url = url.replace("static.inaturalist.org", "inaturalist-open-data.s3.amazonaws.com", 1)
    # Normalise to 'large' size
    url = re.sub(
        r"/(square|small|medium|original)(\.jpe?g)",
        r"/large\2",
        url,
        flags=re.IGNORECASE,
    )
    return url


def download_image(url: str, dest: Path) -> bool:
    if dest.exists():
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iNat-brightness-eval/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
            f.write(r.read())
        return True
    except Exception as e:
        print(f"  ↳ download failed ({url}): {e}")
        return False


def resolve_image(url: str, cache_dir: Path) -> Optional[str]:
    norm = _normalize_url(url)
    import re
    photo_id = re.search(r"/photos/(\d+)/", norm)
    name = (photo_id.group(1) if photo_id else re.sub(r"[^a-zA-Z0-9]", "_", norm)) + ".jpg"
    dest = cache_dir / name
    if download_image(norm, dest):
        return str(dest)
    # Fallback to original URL
    dest2 = cache_dir / (name[:-4] + "_orig.jpg")
    if download_image(url, dest2):
        return str(dest2)
    return None


# ─── Firebase helpers ─────────────────────────────────────────────────────────

def _load_env() -> None:
    if not _ENV_FILE.is_file():
        return
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


def fetch_brightness_log(base_url: str) -> list[dict]:
    """Returns list of {url, brightness} from Firebase brightness_log."""
    url = f"{base_url.rstrip('/')}/brightness_log.json"
    print(f"Fetching brightness log from {url} …")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iNat-brightness-eval/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"  ↳ Failed to fetch brightness log: {e}")
        return []
    if data is None:
        print("  ↳ brightness_log is empty (null).")
        return []
    if isinstance(data, list):
        return [e for e in data if e and "url" in e and "brightness" in e]
    if isinstance(data, dict):
        return [{"url": k, "brightness": v} for k, v in data.items()
                if isinstance(v, (int, float))]
    return []


def fetch_crop_log(base_url: str) -> list[dict]:
    """Returns the crop log as a list of dicts."""
    url = f"{base_url.rstrip('/')}/crop_log.json"
    print(f"Fetching crop log from {url} …")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iNat-brightness-eval/1.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"  ↳ Failed to fetch crop log: {e}")
        return []
    return data or []


# ─── Evaluation ───────────────────────────────────────────────────────────────

def evaluate_with_labels(
    labels: list[dict],       # [{url, brightness}]
    crops_by_url: dict,       # url → {x,y,w,h} (optional, from crop_log)
    cache_dir: Path,
    params_list: list[dict],  # list of {target, tolerance, clamp_min, clamp_max}
) -> None:
    """Evaluate against manually-labeled brightness values."""
    print(f"\n{'='*72}")
    print(f"LABELED EVALUATION — {len(labels)} brightness labels")
    print(f"{'='*72}\n")

    data_points: list[tuple[float, float]] = []  # (measured_luminance, labeled_brightness)
    skipped = 0

    for i, entry in enumerate(labels, 1):
        url = entry["url"]
        labeled = float(entry["brightness"])
        short = url[-60:] if len(url) > 60 else url
        print(f"[{i}/{len(labels)}] {short}")

        crop = crops_by_url.get(url) or crops_by_url.get(
            url.replace("static.inaturalist.org", "inaturalist-open-data.s3.amazonaws.com", 1)
        )

        image_path = resolve_image(url, cache_dir)
        if not image_path:
            print("  ↳ image not found, skipping")
            skipped += 1
            continue

        lum = measure_luminance(image_path, crop)
        if lum is None or lum <= 0:
            print("  ↳ luminance measurement failed, skipping")
            skipped += 1
            continue

        print(f"  luminance={lum:.3f}  labeled_brightness={labeled:.3f}")
        data_points.append((lum, labeled))

    print(f"\nSkipped {skipped}/{len(labels)} entries.\n")

    if not data_points:
        print("No usable data points — cannot evaluate.")
        return

    print(f"Evaluating {len(data_points)} data points.\n")
    print(f"{'Parameters':>50}  {'MAE':>8}  {'RMSE':>8}  {'%exact':>8}")
    print("-" * 80)

    results = []
    for params in params_list:
        target = params.get("target", DEFAULT_TARGET_LUMINANCE)
        tolerance = params.get("tolerance", DEFAULT_TOLERANCE_FACTOR)
        clamp_min = params.get("clamp_min", DEFAULT_CLAMP_MIN)
        clamp_max = params.get("clamp_max", DEFAULT_CLAMP_MAX)
        label = params.get("label", f"target={target:.2f} tol={tolerance:.2f}")

        errors = []
        exact = 0
        for lum, labeled in data_points:
            computed = compute_adjustment(lum, target, tolerance, clamp_min, clamp_max)
            errors.append(abs(computed - labeled))
            if abs(computed - labeled) < 0.01:
                exact += 1

        mae = sum(errors) / len(errors)
        rmse = math.sqrt(sum(e**2 for e in errors) / len(errors))
        pct_exact = 100 * exact / len(errors)
        results.append((mae, rmse, pct_exact, label, params))
        marker = " ◀ current" if params.get("is_current") else ""
        print(f"  {label:>48}  {mae:>8.4f}  {rmse:>8.4f}  {pct_exact:>7.1f}%{marker}")

    print()
    best = min(results, key=lambda r: r[0])
    print(f"Best (lowest MAE): {best[3]}  (MAE={best[0]:.4f}, RMSE={best[1]:.4f})")

    # Correlation between luminance and labeled brightness
    lums = [lum for lum, _ in data_points]
    labeled_vals = [lb for _, lb in data_points]
    mean_lum = sum(lums) / len(lums)
    mean_lb = sum(labeled_vals) / len(labeled_vals)
    cov = sum((l - mean_lum) * (lb - mean_lb) for l, lb in data_points) / len(data_points)
    std_lum = math.sqrt(sum((l - mean_lum)**2 for l in lums) / len(lums))
    std_lb = math.sqrt(sum((lb - mean_lb)**2 for lb in labeled_vals) / len(labeled_vals))
    corr = cov / (std_lum * std_lb) if std_lum > 0 and std_lb > 0 else 0.0
    print(f"\nLuminance↔labeled correlation: {corr:.3f}  "
          f"(mean_lum={mean_lum:.3f}, mean_labeled={mean_lb:.3f})")

    return results


def analyze_luminance_distribution(
    crop_entries: list[dict],
    cache_dir: Path,
    max_images: int = 150,
    target: float = DEFAULT_TARGET_LUMINANCE,
    tolerance: float = DEFAULT_TOLERANCE_FACTOR,
) -> None:
    """
    Download and measure luminance of iNat crop images without brightness labels.
    Provides an empirical characterisation of the algorithm's behaviour.
    """
    print(f"\n{'='*72}")
    print(f"LUMINANCE DISTRIBUTION ANALYSIS — up to {max_images} images")
    print(f"{'='*72}\n")

    luminances: list[float] = []
    skipped = 0

    sample = [e for e in crop_entries
              if "inaturalist-open-data.s3.amazonaws.com" in e.get("url", "")
              or "s3.amazonaws.com" in e.get("url", "")][:max_images]

    for i, entry in enumerate(sample, 1):
        url = entry["url"]
        crop = {k: entry[k] for k in ("x", "y", "w", "h")} if all(k in entry for k in "xywh") else None
        short = url[-55:] if len(url) > 55 else url
        print(f"[{i}/{len(sample)}] {short}")

        image_path = resolve_image(url, cache_dir)
        if not image_path:
            skipped += 1
            continue

        lum = measure_luminance(image_path, crop)
        if lum is None or lum <= 0:
            skipped += 1
            continue

        adj = compute_adjustment(lum, target, tolerance)
        print(f"  luminance={lum:.3f}  adjustment={adj:.3f}")
        luminances.append(lum)

    print(f"\nSkipped {skipped}/{len(sample)} images.\n")

    if not luminances:
        print("No images measured.")
        return

    luminances.sort()
    n = len(luminances)
    mean_lum = sum(luminances) / n
    p10 = luminances[n // 10]
    p25 = luminances[n // 4]
    p50 = luminances[n // 2]
    p75 = luminances[3 * n // 4]
    p90 = luminances[9 * n // 10]

    print(f"Measured luminance on {n} iNat crop images:")
    print(f"  mean={mean_lum:.3f}  p10={p10:.3f}  p25={p25:.3f}  p50={p50:.3f}  "
          f"p75={p75:.3f}  p90={p90:.3f}\n")

    # What adjustments does the current algorithm produce?
    adjustments = [compute_adjustment(l, target, tolerance) for l in luminances]
    no_adj = sum(1 for a in adjustments if a == 1.0)
    brighten = sum(1 for a in adjustments if a > 1.0)
    darken = sum(1 for a in adjustments if a < 1.0)
    mean_adj = sum(adjustments) / len(adjustments)
    adj_gt_2 = sum(1 for a in adjustments if a > 2.0)
    adj_lt_06 = sum(1 for a in adjustments if a < 0.6)

    print(f"Adjustment breakdown (target={target}, tolerance={tolerance}):")
    print(f"  no adjustment (=1.0):    {no_adj:3d} / {n} ({100*no_adj/n:.0f}%)")
    print(f"  brightened   (>1.0):     {brighten:3d} / {n} ({100*brighten/n:.0f}%)")
    print(f"  darkened     (<1.0):     {darken:3d} / {n} ({100*darken/n:.0f}%)")
    print(f"  strong brighten (>2.0):  {adj_gt_2:3d} / {n} ({100*adj_gt_2/n:.0f}%)")
    print(f"  strong darken  (<0.6):   {adj_lt_06:3d} / {n} ({100*adj_lt_06/n:.0f}%)")
    print(f"  mean adjustment:          {mean_adj:.3f}")

    # Sensitivity analysis: how does adjusting target change the breakdown?
    print(f"\nSensitivity: % images needing no adjustment for different targets:")
    print(f"  {'Target':>8}  {'No adjust':>12}  {'Brighten':>10}  {'Darken':>8}  {'Mean adj':>10}")
    print("  " + "-" * 55)
    for t in [0.30, 0.35, 0.40, 0.42, 0.45, 0.48, 0.50, 0.55, 0.60]:
        adjs = [compute_adjustment(l, t, tolerance) for l in luminances]
        na = sum(1 for a in adjs if a == 1.0)
        br = sum(1 for a in adjs if a > 1.0)
        dk = sum(1 for a in adjs if a < 1.0)
        ma = sum(adjs) / len(adjs)
        cur = " ◀ current" if abs(t - target) < 0.001 else ""
        print(f"  {t:>8.2f}  {na:>5}/{n} ({100*na/n:4.0f}%)  "
              f"{br:>5}/{n} ({100*br/n:3.0f}%)  "
              f"{dk:>5}/{n} ({100*dk/n:3.0f}%)  "
              f"{ma:>10.3f}{cur}")

    print(f"\nSensitivity: % images needing no adjustment for different tolerances:")
    print(f"  {'Tolerance':>10}  {'No adjust':>12}  {'Tolerance range':>18}")
    print("  " + "-" * 48)
    for tol in [0.05, 0.08, 0.10, 0.12, 0.15, 0.20, 0.25, 0.30]:
        adjs = [compute_adjustment(l, target, tol) for l in luminances]
        na = sum(1 for a in adjs if a == 1.0)
        # tolerance range in luminance units
        lum_lo = target / (1 + tol)
        lum_hi = target / (1 - tol) if tol < 1 else 999
        cur = " ◀ current" if abs(tol - tolerance) < 0.001 else ""
        print(f"  {tol:>10.2f}  {na:>5}/{n} ({100*na/n:4.0f}%)  "
              f"  [{lum_lo:.3f}, {lum_hi:.3f}]{cur}")

    return luminances, adjustments


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--cache-dir", default=str(CACHE_DIR_DEFAULT),
                        help="Directory for cached images (default: /tmp/inat_brightness_cache)")
    parser.add_argument("--no-firebase", action="store_true",
                        help="Skip Firebase fetch; run distribution analysis only")
    parser.add_argument("--max-images", type=int, default=150,
                        help="Max images for distribution analysis (default: 150)")
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    _load_env()
    base_url = os.environ.get("CROP_LOG_FIREBASE_URL", _DEFAULT_FIREBASE_URL).strip()

    # Parameter sets to evaluate
    params_list = [
        dict(label="current (target=0.45, tol=0.15)", is_current=True,
             target=0.45, tolerance=0.15, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.40, tol=0.15",
             target=0.40, tolerance=0.15, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.42, tol=0.15",
             target=0.42, tolerance=0.15, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.48, tol=0.15",
             target=0.48, tolerance=0.15, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.50, tol=0.15",
             target=0.50, tolerance=0.15, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.45, tol=0.10",
             target=0.45, tolerance=0.10, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.45, tol=0.20",
             target=0.45, tolerance=0.20, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.45, tol=0.25",
             target=0.45, tolerance=0.25, clamp_min=0.4, clamp_max=3.0),
        dict(label="target=0.45, tol=0.15, clamp_max=2.0",
             target=0.45, tolerance=0.15, clamp_min=0.4, clamp_max=2.0),
        dict(label="target=0.45, tol=0.15, clamp_max=2.5",
             target=0.45, tolerance=0.15, clamp_min=0.4, clamp_max=2.5),
    ]

    labels: list[dict] = []
    crops_by_url: dict = {}

    if not args.no_firebase:
        labels = fetch_brightness_log(base_url)
        print(f"  Got {len(labels)} brightness labels.")

        if labels:
            # Also fetch crop log to have crop regions for luminance measurement
            crop_entries = fetch_crop_log(base_url)
            crops_by_url = {e["url"]: {k: e[k] for k in "xywh"} for e in crop_entries if "x" in e}
            print(f"  Got {len(crops_by_url)} crop regions.\n")
        else:
            print("  No brightness labels found in Firebase.")

    if labels:
        evaluate_with_labels(labels, crops_by_url, cache_dir, params_list)
    else:
        print("\nNo labeled brightness data available.")
        print("Running luminance distribution analysis on crop_training.json instead.\n")

        crop_file = REPO_ROOT / "crop_training.json"
        if not crop_file.is_file():
            print(f"  {crop_file} not found; no analysis possible.")
            return

        crop_entries = json.loads(crop_file.read_text())
        analyze_luminance_distribution(crop_entries, cache_dir, max_images=args.max_images)

    print("\nDone.\n")


if __name__ == "__main__":
    main()
