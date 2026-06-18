#!/usr/bin/env python3
"""
Tune auto-brightness algorithm parameters using labeled brightness values.

For each labeled image the script:
  1. Resolves the crop region: uses the entry from crop_training.json if
     available; otherwise runs the deployed YOLO model + saliency fallback
     (same logic as ImageCropper.m).
  2. Measures average perceptual luminance of that crop region at 64×64
     (identical to the native measureAverageLuminance() in ImageCropper.m).
  3. Grid-searches over TARGET_LUMINANCE × TOLERANCE_FACTOR to minimise
     mean-absolute-error in brightness stops (log2 scale).

Parameters tuned (both live in src/sharedHelpers/useAutoBrightnessForUri.ts):
  TARGET_LUMINANCE  the luminance level the algorithm aims for (default 0.45)
  TOLERANCE_FACTOR  suppress adjustments smaller than this (default 0.15)

Metrics:
  MAE (stops)  Mean |log2(predicted) − log2(labeled)| — lower is better.
               ≈0 stops = perfect, 0.5 stops ≈ 41% off, 1 stop = 2× off.

Usage:
    python3 scripts/tune_brightness.py [brightness_training.json] [crop_training.json]
    CROP_LOG_FIREBASE_URL=https://project.firebaseio.com python3 scripts/tune_brightness.py
"""

from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )
from evaluate_subject_detector import resolve_image, get_image_size, _spectral_saliency_bounds

try:
    from PIL import Image as PILImage
except ImportError:
    sys.exit( "pip install pillow" )

try:
    import onnxruntime as ort
    _HAS_ORT = True
except ImportError:
    _HAS_ORT = False

REPO_ROOT  = Path( __file__ ).parent.parent
CACHE_DIR  = Path( "/tmp/inat_brightness_cache" )
MODEL_PATH = REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"

YOLO_INPUT_SIZE = 640
YOLO_CONF_THRESH = 0.05
YOLO_GATE_CONF   = 0.25
YOLO_IOU_THRESH  = 0.45
YOLO_UNION_THRESH = 0.60
YOLO_UNION_MAX_K  = 3
YOLO_PADDING      = 0.12  # matches subjectDetectionModels.ts

_sess = None


def _get_session():
    global _sess
    if _sess is None and _HAS_ORT and MODEL_PATH.is_file():
        _sess = ort.InferenceSession( str( MODEL_PATH ) )
    return _sess


# ── Replicate the iOS letterbox + NMS + union pipeline ──────────────────────

def _letterbox( img_arr, size=YOLO_INPUT_SIZE ):
    img = PILImage.fromarray( img_arr )
    w, h = img.size
    scale = size / max( w, h )
    nw, nh = int( w * scale ), int( h * scale )
    resized = img.resize( (nw, nh), PILImage.BILINEAR )
    pad_l = (size - nw) // 2
    pad_t = (size - nh) // 2
    canvas = PILImage.new( "RGB", (size, size), (114, 114, 114) )
    canvas.paste( resized, (pad_l, pad_t) )
    return np.array( canvas ).astype( np.float32 ) / 255.0, pad_l, pad_t, scale


def _nms( boxes, scores, iou_thresh ):
    order = np.argsort( scores )[::-1]
    kept = []
    while len( order ) > 0:
        i = order[0]; kept.append( i )
        if len( order ) == 1: break
        x1 = np.maximum( boxes[i, 0], boxes[order[1:], 0] )
        y1 = np.maximum( boxes[i, 1], boxes[order[1:], 1] )
        x2 = np.minimum( boxes[i, 2], boxes[order[1:], 2] )
        y2 = np.minimum( boxes[i, 3], boxes[order[1:], 3] )
        inter = np.maximum( 0, x2 - x1 ) * np.maximum( 0, y2 - y1 )
        area_i = (boxes[i, 2] - boxes[i, 0]) * (boxes[i, 3] - boxes[i, 1])
        area_r = ((boxes[order[1:], 2] - boxes[order[1:], 0]) *
                  (boxes[order[1:], 3] - boxes[order[1:], 1]))
        union = area_i + area_r - inter
        iou = np.where( union > 0, inter / union, 0 )
        order = order[1:][iou <= iou_thresh]
    return kept


def _detect_crop_yolo( image_path: str ) -> tuple | None:
    """Run YOLO + saliency, return (x, y, w, h) normalized crop or None."""
    sess = _get_session()
    if sess is None:
        return None
    try:
        img = PILImage.open( image_path ).convert( "RGB" )
        orig_w, orig_h = img.size
        lb, pad_l, pad_t, scale = _letterbox( np.array( img ) )
        x_in = lb.transpose( 2, 0, 1 )[None]
        out = sess.run( None, {"images": x_in} )[0][0]  # [rows, 8400]

        num_rows = out.shape[0]
        max_scores = out[4:].max( axis=0 ) if num_rows > 5 else out[4]
        mask = max_scores >= YOLO_CONF_THRESH
        if mask.any():
            cx, cy, w, h = out[0][mask], out[1][mask], out[2][mask], out[3][mask]
            conf = max_scores[mask]
            x1 = cx - w / 2; y1 = cy - h / 2; x2 = cx + w / 2; y2 = cy + h / 2
            boxes = np.stack( [x1, y1, x2, y2], axis=1 )
            kept = _nms( boxes, conf, YOLO_IOU_THRESH )
            if kept:
                kept_conf = conf[kept]
                kept_boxes = boxes[kept]
                best_conf = float( kept_conf[0] )
                if best_conf >= YOLO_GATE_CONF:
                    thresh = YOLO_UNION_THRESH * best_conf
                    valid = [(kept_boxes[i], kept_conf[i])
                             for i in range( min( len( kept ), YOLO_UNION_MAX_K ) )
                             if kept_conf[i] >= thresh]
                    if not valid:
                        valid = [(kept_boxes[0], kept_conf[0])]
                    ux1 = min( b[0, 0] for b, _ in valid )
                    uy1 = min( b[0, 1] for b, _ in valid )
                    ux2 = max( b[0, 2] for b, _ in valid )
                    uy2 = max( b[0, 3] for b, _ in valid )
                    bx = max( 0.0, min( 1.0, (float( ux1 ) - pad_l) / scale / orig_w ) )
                    by = max( 0.0, min( 1.0, (float( uy1 ) - pad_t) / scale / orig_h ) )
                    bw = max( 0.01, min( 1.0 - bx, (float( ux2 ) - float( ux1 )) / scale / orig_w ) )
                    bh = max( 0.01, min( 1.0 - by, (float( uy2 ) - float( uy1 )) / scale / orig_h ) )
                    # Apply padding (mirrors subjectBoundsToNormalizedCrop.ts)
                    pad = YOLO_PADDING
                    side = min( bw, bh )
                    cx_ = bx + bw / 2; cy_ = by + bh / 2
                    half = side / 2 + pad
                    return (
                        max( 0.0, min( 1.0, cx_ - half ) ),
                        max( 0.0, min( 1.0, cy_ - half ) ),
                        min( 1.0, 2 * half ),
                        min( 1.0, 2 * half ),
                    )

    except Exception as e:
        print( f"  YOLO error on {image_path}: {e}" )

    # Saliency fallback
    sal = _spectral_saliency_bounds( image_path )
    return sal  # already (x, y, w, h) or None


# ── Luminance measurement (mirrors measureAverageLuminance in ImageCropper.m) ─

def measure_luminance( image_path: str, crop: tuple | None ) -> float | None:
    """Average perceptual luminance in the crop region at 64×64 sampling."""
    try:
        img = PILImage.open( image_path ).convert( "RGB" )
        iw, ih = img.size

        if crop:
            x, y, w, h = crop
            # Scale image so the crop region fills the 64×64 canvas
            scale_x = 64.0 / (w * iw)
            scale_y = 64.0 / (h * ih)
            draw_w = max( 1, int( iw * scale_x ) )
            draw_h = max( 1, int( ih * scale_y ) )
            draw_x = -int( x * iw * scale_x )
            draw_y = -int( y * ih * scale_y )
            canvas = PILImage.new( "RGB", (64, 64), (114, 114, 114) )
            canvas.paste( img.resize( (draw_w, draw_h), PILImage.BILINEAR ), (draw_x, draw_y) )
        else:
            canvas = img.resize( (64, 64), PILImage.BILINEAR )

        arr = np.array( canvas ).astype( np.float32 ) / 255.0
        lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        return float( lum.mean() )
    except Exception as e:
        print( f"  luminance error on {image_path}: {e}" )
        return None


# ── Algorithm simulation ─────────────────────────────────────────────────────

def predicted_brightness( luminance: float, target: float, tolerance: float ) -> float:
    """Replicates computeAdjustment() in useAutoBrightnessForUri.ts."""
    if luminance <= 0:
        return 1.0
    adj = target / luminance
    if abs( adj - 1.0 ) < tolerance:
        return 1.0
    return max( 0.4, min( 3.0, adj ) )


def mae_stops( predicted: list[float], labeled: list[float] ) -> float:
    errors = [abs( math.log2( max( 0.01, p ) ) - math.log2( max( 0.01, l ) ) )
              for p, l in zip( predicted, labeled )]
    return sum( errors ) / len( errors ) if errors else float( "inf" )


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    CACHE_DIR.mkdir( parents=True, exist_ok=True )

    # Load brightness labels
    brightness_path = (
        Path( sys.argv[1] ) if len( sys.argv ) > 1
        else REPO_ROOT / "brightness_training.json"
    )
    if not brightness_path.is_file():
        sys.exit(
            f"{brightness_path} not found.\n"
            "Run: python3 scripts/pull_brightness_log.py"
        )
    labels = json.loads( brightness_path.read_text() )
    print( f"Loaded {len(labels)} brightness labels from {brightness_path.name}." )

    # Load crop hints from crop_training.json for crop-region measurements
    crop_path = (
        Path( sys.argv[2] ) if len( sys.argv ) > 2
        else REPO_ROOT / "crop_training.json"
    )
    crop_hints: dict[str, tuple] = {}
    if crop_path.is_file():
        try:
            raw = json.loads( crop_path.read_text() )
            entries = raw if isinstance( raw, list ) else list( raw.values() )
            for e in entries:
                c = e.get( "crop", e ) if isinstance( e, dict ) else None
                if c and "url" in e and all( k in c for k in ("x", "y", "w", "h") ):
                    crop_hints[e["url"]] = (c["x"], c["y"], c["w"], c["h"])
            print( f"Loaded {len(crop_hints)} crop hints from {crop_path.name}." )
        except Exception as ex:
            print( f"Warning: could not load crop hints — {ex}" )

    # Collect (luminance, labeled_brightness) pairs
    data: list[tuple[float, float]] = []
    yolo_used = saliency_used = crop_hint_used = full_img_used = 0

    print( f"\nMeasuring luminance for {len(labels)} images …" )
    for i, entry in enumerate( labels ):
        url = entry.get( "url", "" )
        labeled = float( entry.get( "brightness", 1.0 ) )
        if not url or labeled <= 0:
            continue

        if i % 20 == 0:
            print( f"  [{i}/{len(labels)}]" )

        image_path = resolve_image( url, None, CACHE_DIR )
        if not image_path:
            print( f"  Could not download {url}" )
            continue

        # Determine crop: prefer crop_training.json hint, then YOLO, then full image
        crop: tuple | None = crop_hints.get( url )
        if crop:
            crop_hint_used += 1
        else:
            detected = _detect_crop_yolo( image_path )
            if detected:
                crop = detected
                yolo_used += 1
            else:
                saliency_used += 1

        lum = measure_luminance( image_path, crop )
        if lum is None or lum <= 0:
            full_img_used += 1
            lum = measure_luminance( image_path, None )
        if lum is None or lum <= 0:
            continue

        data.append( (lum, labeled) )

    print( f"\nMeasured {len(data)} images." )
    print( f"  Crop source: {crop_hint_used} from crop log, "
           f"{yolo_used} YOLO, {saliency_used} saliency, {full_img_used} full-image fallback." )

    if not data:
        sys.exit( "No images measured — nothing to tune." )

    luminances, labeled_brights = zip( *data )

    # Baseline with current defaults
    CURRENT_TARGET    = 0.45
    CURRENT_TOLERANCE = 0.15
    baseline_preds = [predicted_brightness( l, CURRENT_TARGET, CURRENT_TOLERANCE )
                      for l in luminances]
    baseline_mae = mae_stops( baseline_preds, labeled_brights )
    print( f"\nBaseline (target={CURRENT_TARGET}, tolerance={CURRENT_TOLERANCE}): "
           f"MAE = {baseline_mae:.4f} stops" )

    # Grid search
    targets    = [round( t, 2 ) for t in np.arange( 0.25, 0.70, 0.025 )]
    tolerances = [round( t, 2 ) for t in np.arange( 0.05, 0.35, 0.025 )]

    best_mae    = baseline_mae
    best_target = CURRENT_TARGET
    best_tol    = CURRENT_TOLERANCE
    n_tested    = 0

    for target in targets:
        for tol in tolerances:
            preds = [predicted_brightness( l, target, tol ) for l in luminances]
            mae   = mae_stops( preds, labeled_brights )
            n_tested += 1
            if mae < best_mae:
                best_mae    = mae
                best_target = target
                best_tol    = tol
                print( f"  ★ New best: target={target}, tolerance={tol}, MAE={mae:.4f} stops" )

    print( f"\nTested {n_tested} combinations." )

    delta = best_mae - baseline_mae
    sign  = "+" if delta >= 0 else ""
    print( f"\nBest: TARGET_LUMINANCE={best_target}, TOLERANCE_FACTOR={best_tol}" )
    print( f"  MAE = {best_mae:.4f} stops  (Δ vs baseline: {sign}{delta:.4f})" )

    if best_mae < baseline_mae:
        print( f"\nRecommendation: update src/sharedHelpers/useAutoBrightnessForUri.ts:" )
        print( f"  TARGET_LUMINANCE  → {best_target}" )
        print( f"  TOLERANCE_FACTOR  → {best_tol}" )
    else:
        print( "\nCurrent defaults are already optimal for this dataset." )

    # Distribution summary
    print( f"\nDataset brightness distribution:" )
    for label, pct in [("p10", 10), ("p25", 25), ("p50", 50), ("p75", 75), ("p90", 90)]:
        lv = float( np.percentile( labeled_brights, pct ) )
        lum_v = float( np.percentile( luminances, pct ) )
        print( f"  {label}: labeled brightness={lv:.2f}×  measured luminance={lum_v:.3f}" )


if __name__ == "__main__":
    main()
