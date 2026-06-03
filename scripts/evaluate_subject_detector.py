#!/usr/bin/env python3
"""
Evaluate and tune the iNaturalist subject detector using exported crop feedback.

Reads the JSON exported via Menu → "Copy crop feedback JSON", downloads the
original images, re-runs Apple's Vision-based subject detection, and evaluates
how well different padding values match the crops you actually chose.

Requirements (macOS only):
    pip3 install pyobjc requests

Usage:
    python3 scripts/evaluate_subject_detector.py crop_feedback.json
    python3 scripts/evaluate_subject_detector.py crop_feedback.json \\
        --photos-dir ~/Desktop/inat-photos
    python3 scripts/evaluate_subject_detector.py crop_feedback.json \\
        --paddings 0.05,0.10,0.12,0.15,0.20,0.25,0.30
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Pure-Python helpers — replicate subjectBoundsToNormalizedCrop.ts
# ---------------------------------------------------------------------------

@dataclass
class Crop:
    x: float
    y: float
    w: float
    h: float


def clamp_crop(x: float, y: float, w: float, h: float,
               min_frac: float = 0.05) -> Crop:
    w = max(min_frac, min(1.0, w))
    h = max(min_frac, min(1.0, h))
    x = max(0.0, min(1.0 - w, x))
    y = max(0.0, min(1.0 - h, y))
    return Crop(x, y, w, h)


def bounds_to_crop(bx: float, by: float, bw: float, bh: float,
                   padding: float,
                   image_width: int = 0, image_height: int = 0) -> Crop:
    """Exact replica of subjectBoundsToNormalizedCrop.ts."""
    if bw <= 0 or bh <= 0:
        return Crop(0, 0, 1, 1)
    if image_width > 0 and image_height > 0:
        padded_w = bw * (1 + padding)
        padded_h = bh * (1 + padding)
        pixel_side = min(
            max(padded_w * image_width, padded_h * image_height),
            image_width,
            image_height,
        )
        w = pixel_side / image_width
        h = pixel_side / image_height
        cx = bx + bw / 2
        cy = by + bh / 2
        x = max(0.0, min(1.0 - w, cx - w / 2))
        y = max(0.0, min(1.0 - h, cy - h / 2))
        return Crop(x, y, w, h)
    # Fallback when image dimensions are unavailable (normalized-space squaring)
    pad_w = bw * padding
    pad_h = bh * padding
    x = bx - pad_w / 2
    y = by - pad_h / 2
    w = bw + pad_w
    h = bh + pad_h
    side = max(w, h)
    cx = x + w / 2
    cy = y + h / 2
    x = cx - side / 2
    y = cy - side / 2
    return clamp_crop(x, y, side, side)


def iou(a: Crop, b: Crop) -> float:
    x1 = max(a.x, b.x)
    y1 = max(a.y, b.y)
    x2 = min(a.x + a.w, b.x + b.w)
    y2 = min(a.y + a.h, b.y + b.h)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


# ---------------------------------------------------------------------------
# Apple Vision detection via PyObjC (macOS only)
# ---------------------------------------------------------------------------

def _require_objc() -> None:
    try:
        import objc  # noqa: F401
    except ImportError:
        sys.exit("PyObjC is required. Install with:  pip3 install pyobjc\n")


def detect_bounds_vision(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Run the same Vision requests as ImageCropper.m and return the union
    bounding box as (x, y, width, height) in top-left normalised coords,
    or None if nothing was detected.
    """
    _require_objc()
    import objc  # noqa: F401
    from Foundation import NSURL
    from Vision import (
        VNDetectHumanRectanglesRequest,
        VNGenerateAttentionBasedSaliencyImageRequest,
        VNImageRequestHandler,
    )
    try:
        from Vision import VNRecognizeAnimalsRequest
        has_animals = True
    except ImportError:
        has_animals = False

    url = NSURL.fileURLWithPath_(os.path.abspath(image_path))
    handler = VNImageRequestHandler.alloc().initWithURL_options_(url, {})

    human_req = VNDetectHumanRectanglesRequest.alloc().init()
    saliency_req = VNGenerateAttentionBasedSaliencyImageRequest.alloc().init()
    requests = [human_req, saliency_req]
    if has_animals:
        animal_req = VNRecognizeAnimalsRequest.alloc().init()
        requests.append(animal_req)

    success, _ = handler.performRequests_error_(requests, None)
    if not success:
        return None

    boxes: list[tuple[float, float, float, float]] = []

    for obs in (human_req.results() or []):
        bb = obs.boundingBox()
        boxes.append((bb.origin.x, bb.origin.y,
                      bb.origin.x + bb.size.width, bb.origin.y + bb.size.height))

    if has_animals:
        for obs in (animal_req.results() or []):
            if obs.confidence() < 0.3:
                continue
            bb = obs.boundingBox()
            boxes.append((bb.origin.x, bb.origin.y,
                          bb.origin.x + bb.size.width, bb.origin.y + bb.size.height))

    for obs in (saliency_req.results() or []):
        for rect_obs in (obs.salientObjects() or []):
            bb = rect_obs.boundingBox()
            boxes.append((bb.origin.x, bb.origin.y,
                          bb.origin.x + bb.size.width, bb.origin.y + bb.size.height))

    if not boxes:
        return None

    min_x = min(b[0] for b in boxes)
    min_y = min(b[1] for b in boxes)
    max_x = max(b[2] for b in boxes)
    max_y = max(b[3] for b in boxes)
    bw = max_x - min_x
    bh = max_y - min_y
    if bw <= 0 or bh <= 0:
        return None

    # Vision uses bottom-left origin; flip Y to top-left to match the app
    return (min_x, 1.0 - min_y - bh, bw, bh)


# ---------------------------------------------------------------------------
# Image acquisition
# ---------------------------------------------------------------------------

INATURALIST_SIZE_RE = re.compile(
    r"(https://[^?]+/photos/\d+/)(square|small|medium|large|original)(\.jpe?g)",
    re.IGNORECASE,
)


def inaturalist_original_url(url: str) -> str:
    m = INATURALIST_SIZE_RE.match(url)
    return m.group(1) + "original" + m.group(3) if m else url


def download_image(url: str, dest: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iNat-crop-eval/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        return True
    except Exception as exc:
        print(f"  ↳ download failed: {exc}")
        return False


def resolve_image(key: str, photos_dir: Optional[Path], cache_dir: Path) -> Optional[str]:
    if key.startswith("file://"):
        local = key[len("file://"):]
        if os.path.isfile(local):
            return local
        if photos_dir:
            candidate = photos_dir / Path(local).name
            if candidate.is_file():
                return str(candidate)
        return None

    if key.startswith("/") and os.path.isfile(key):
        return key

    if "inaturalist.org" in key or "static.inaturalist" in key:
        orig_url = inaturalist_original_url(key)
        photo_id = re.search(r"/photos/(\d+)/", orig_url)
        name = (photo_id.group(1) if photo_id
                else re.sub(r"[^a-zA-Z0-9]", "_", orig_url)) + ".jpg"
        dest = cache_dir / name
        if dest.is_file():
            return str(dest)
        print(f"  Downloading {orig_url} …")
        if download_image(orig_url, str(dest)):
            return str(dest)
        dest2 = cache_dir / (name + "_sq.jpg")
        if dest2.is_file():
            return str(dest2)
        if download_image(key, str(dest2)):
            return str(dest2)
        return None

    return None


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def get_image_size(image_path: str) -> tuple[int, int]:
    """Return (width, height) of the image, or (0, 0) on failure."""
    try:
        from PIL import Image as PILImage  # type: ignore[import]
        with PILImage.open(image_path) as img:
            return img.size  # (width, height)
    except Exception:
        pass
    try:
        import objc  # noqa: F401
        from Foundation import NSURL
        from ImageIO import CGImageSourceCreateWithURL, CGImageSourceCopyPropertiesAtIndex
        url = NSURL.fileURLWithPath_(os.path.abspath(image_path))
        src = CGImageSourceCreateWithURL(url, None)
        if src:
            props = CGImageSourceCopyPropertiesAtIndex(src, 0, None)
            if props:
                w = props.get("PixelWidth", 0)
                h = props.get("PixelHeight", 0)
                if w and h:
                    return int(w), int(h)
    except Exception:
        pass
    return (0, 0)


@dataclass
class EvalEntry:
    key: str
    truth: Crop
    kept: bool
    bounds: Optional[tuple[float, float, float, float]]
    image_width: int = 0
    image_height: int = 0


@dataclass
class PaddingResult:
    padding: float
    mean_iou: float
    median_iou: float
    pct_above_07: float
    pct_above_05: float
    ious: list[float] = field(default_factory=list)


def evaluate(entries: list[EvalEntry], paddings: list[float]) -> list[PaddingResult]:
    detected = [e for e in entries if e.bounds is not None]
    print(f"Detection succeeded on {len(detected)}/{len(entries)} images.\n")
    results = []
    for pad in paddings:
        ious = sorted(
            iou(bounds_to_crop(*e.bounds, pad, e.image_width, e.image_height), e.truth)  # type: ignore[arg-type]
            for e in detected
        )
        n = len(ious)
        mean = sum(ious) / n if n else 0.0
        median = ious[n // 2] if n else 0.0
        pct07 = sum(1 for v in ious if v >= 0.7) / n * 100 if n else 0.0
        pct05 = sum(1 for v in ious if v >= 0.5) / n * 100 if n else 0.0
        results.append(PaddingResult(pad, mean, median, pct07, pct05, ious))
    return results


def print_report(results: list[PaddingResult], entries: list[EvalEntry],
                 current_padding: float) -> None:
    kept = sum(1 for e in entries if e.kept)
    print("=" * 60)
    print(f"Total: {len(entries)}  |  Photo kept: {kept} ({kept/len(entries)*100:.0f}%)")
    print("=" * 60)
    print(f"\n{'Padding':>10}  {'Mean IoU':>9}  {'Median':>7}  {'≥0.7':>6}  {'≥0.5':>6}")
    print("-" * 50)
    best = max(results, key=lambda r: r.mean_iou)
    for r in results:
        cur = " ◀ current" if abs(r.padding - current_padding) < 1e-6 else ""
        star = " ★ BEST" if r is best else ""
        print(f"  {r.padding:>6.2f}    {r.mean_iou:>8.3f}   {r.median_iou:>6.3f}  "
              f"{r.pct_above_07:>5.1f}%  {r.pct_above_05:>5.1f}%{cur}{star}")
    print()
    current_result = next(
        (r for r in results if abs(r.padding - current_padding) < 1e-6), None
    )
    if current_result and best.padding != current_padding:
        delta = best.mean_iou - current_result.mean_iou
        print(
            f"Recommendation: update SUBJECT_DETECTION_MODEL_PADDING\n"
            f"  {current_padding} → {best.padding}  (+{delta:.3f} mean IoU)\n"
            f"  src/sharedHelpers/subjectDetectionModels.ts\n"
        )
    else:
        print(f"Current padding ({current_padding}) is already optimal.\n")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("feedback_json", help="Path to exported crop feedback JSON")
    parser.add_argument("--photos-dir", metavar="DIR",
                        help="Folder of Apple Photos exports (for file:// entries)")
    parser.add_argument("--paddings",
                        default="0.00,0.05,0.08,0.10,0.12,0.15,0.18,0.20,0.25,0.30",
                        help="Comma-separated padding values to test")
    parser.add_argument("--cache-dir", default=None,
                        help="Cache directory for downloaded images")
    args = parser.parse_args()

    paddings = [float(p.strip()) for p in args.paddings.split(",")]
    photos_dir = Path(args.photos_dir).expanduser() if args.photos_dir else None

    with open(args.feedback_json) as f:
        raw: dict = json.load(f)

    entries_raw = [
        (key, val) for key, val in raw.items()
        if val.get("crop") is not None
    ]
    print(f"Loaded {len(raw)} entries, {len(entries_raw)} with crop data.\n")

    with tempfile.TemporaryDirectory() as tmp:
        cache_dir = Path(args.cache_dir) if args.cache_dir else Path(tmp)
        cache_dir.mkdir(parents=True, exist_ok=True)

        eval_entries: list[EvalEntry] = []
        skipped = 0

        for i, (key, val) in enumerate(entries_raw, 1):
            c = val["crop"]
            truth = Crop(c["x"], c["y"], c["w"], c["h"])
            kept = bool(val.get("kept", True))
            short_key = key[-60:] if len(key) > 60 else key
            print(f"[{i}/{len(entries_raw)}] {short_key}")
            image_path = resolve_image(key, photos_dir, cache_dir)
            if not image_path:
                print("  ↳ image not found, skipping")
                skipped += 1
                continue
            img_w, img_h = get_image_size(image_path)
            bounds = detect_bounds_vision(image_path)
            if bounds is None:
                print("  ↳ Vision returned no results (fallback crop)")
            eval_entries.append(EvalEntry(key, truth, kept, bounds, img_w, img_h))

        if skipped:
            print(f"\nSkipped {skipped} entries (image not found).")
        if not eval_entries:
            sys.exit("No images could be evaluated.")

        results = evaluate(eval_entries, paddings)
        print_report(results, eval_entries, current_padding=0.0)

        csv_path = Path(args.feedback_json).with_suffix(".eval.csv")
        with open(csv_path, "w") as csvf:
            header = "key,truth_x,truth_y,truth_w,truth_h,kept,detected"
            for p in paddings:
                header += f",iou_{p:.2f}"
            csvf.write(header + "\n")
            for e in eval_entries:
                row = (f"{e.key},{e.truth.x:.4f},{e.truth.y:.4f},"
                       f"{e.truth.w:.4f},{e.truth.h:.4f},{int(e.kept)},"
                       f"{int(e.bounds is not None)}")
                for r in results:
                    if e.bounds is not None:
                        pred = bounds_to_crop(*e.bounds, r.padding, e.image_width, e.image_height)
                        row += f",{iou(pred, e.truth):.4f}"
                    else:
                        row += ","
                csvf.write(row + "\n")
        print(f"Per-entry CSV: {csv_path}\n")


if __name__ == "__main__":
    main()
