#!/usr/bin/env python3
"""
Evaluate and tune the iNaturalist subject detector using exported crop feedback.

Reads the JSON exported via Menu → "Copy crop feedback JSON" (or crop_training.json),
downloads the original images, re-runs subject detection, and evaluates how well
different padding values and detection strategies match the crops you actually chose.

Two metrics (both 0–1, higher = better):
  recall    = fraction of ground-truth crop covered by the AI crop
              (must be ≈1.0 — the AI crop should always contain the subject)
  precision = fraction of the AI crop that overlaps with ground truth
              (tightness; 1.0 = perfect fit)

Weighted score = (2·recall + 1·precision) / 3

Two detection algorithms are compared:
  current  — union of all detections (human ∪ animal ∪ all saliency objects)
             mirrors the current ImageCropper.m behaviour
  improved — if a human or animal is found, use only those boxes;
             fall back to saliency only when nothing is detected

Backends:
  yolo    — YOLOv8n + spectral-residual saliency (runs on Linux/macOS)
             pip install ultralytics pillow opencv-python-headless
  vision  — Apple Vision framework via PyObjC (macOS only)
             pip install pyobjc

Usage:
    python3 scripts/evaluate_subject_detector.py
    python3 scripts/evaluate_subject_detector.py crop_training.json
    python3 scripts/evaluate_subject_detector.py crop_feedback.json \\
        --backend vision --photos-dir ~/Desktop/inat-photos
    python3 scripts/evaluate_subject_detector.py crop_training.json \\
        --paddings 0.05,0.10,0.15,0.20,0.25,0.30

When no file is given the crop log is fetched live from Firebase Realtime
Database using CROP_LOG_FIREBASE_URL from .env.
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
    """Exact replica of subjectBoundsToNormalizedCrop.ts.

    When the padded subject exceeds the image dimensions, w or h may be > 1
    and x or y may be negative (letterbox case — caller shows black bars).
    """
    if bw <= 0 or bh <= 0:
        return Crop(0, 0, 1, 1)
    if image_width > 0 and image_height > 0:
        padded_w = bw * (1 + padding)
        padded_h = bh * (1 + padding)
        # No longer clamped to image dimensions — very large subjects letterbox.
        pixel_side = max(padded_w * image_width, padded_h * image_height)
        w = pixel_side / image_width
        h = pixel_side / image_height
        cx = bx + bw / 2
        cy = by + bh / 2
        # Clamp only when the crop fits within the image.
        x = (max(0.0, min(1.0 - w, cx - w / 2)) if w <= 1.0
             else cx - w / 2)
        y = (max(0.0, min(1.0 - h, cy - h / 2)) if h <= 1.0
             else cy - h / 2)
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


def intersection_area(a: Crop, b: Crop) -> float:
    x1 = max(a.x, b.x)
    y1 = max(a.y, b.y)
    x2 = min(a.x + a.w, b.x + b.w)
    y2 = min(a.y + a.h, b.y + b.h)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return (x2 - x1) * (y2 - y1)


def iou(a: Crop, b: Crop) -> float:
    inter = intersection_area(a, b)
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def recall(pred: Crop, truth: Crop) -> float:
    """Fraction of ground-truth crop area covered by the predicted crop."""
    truth_area = truth.w * truth.h
    if truth_area <= 0:
        return 0.0
    return intersection_area(pred, truth) / truth_area


def precision(pred: Crop, truth: Crop) -> float:
    """Fraction of predicted crop area that overlaps with ground truth."""
    pred_area = pred.w * pred.h
    if pred_area <= 0:
        return 0.0
    return intersection_area(pred, truth) / pred_area


# Weight recall (superset coverage) twice as much as precision (tightness).
RECALL_WEIGHT = 2.0
PRECISION_WEIGHT = 1.0


def weighted_score(pred: Crop, truth: Crop) -> float:
    r = recall(pred, truth)
    p = precision(pred, truth)
    return (RECALL_WEIGHT * r + PRECISION_WEIGHT * p) / (RECALL_WEIGHT + PRECISION_WEIGHT)


# ---------------------------------------------------------------------------
# YOLO + spectral saliency detection backend (Linux / macOS)
# ---------------------------------------------------------------------------

# COCO class IDs that count as "animals" for iNaturalist purposes.
# Covers the species Apple's VNRecognizeAnimalsRequest targets plus common wildlife.
_YOLO_ANIMAL_CLASSES = {
    14,  # bird
    15,  # cat
    16,  # dog
    17,  # horse
    18,  # sheep
    19,  # cow
    20,  # elephant
    21,  # bear
    22,  # zebra
    23,  # giraffe
}
_YOLO_PERSON_CLASS = 0
_YOLO_MIN_CONF = 0.25

_yolo_model = None


def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        try:
            from ultralytics import YOLO  # type: ignore[import]
            _yolo_model = YOLO("yolov8n.pt")
        except ImportError:
            sys.exit(
                "ultralytics is required for the YOLO backend.\n"
                "  pip install ultralytics\n"
            )
    return _yolo_model


def _spectral_saliency_bounds(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Spectral Residual saliency (Hou & Zhang 2007) — a fast CPU-only approximation
    of attention-based saliency.  Returns (x, y, w, h) in top-left normalized coords,
    or None if no salient region is found.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None

    img = cv2.imread(image_path)
    if img is None:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Resize to fixed size for speed / stability
    size = 64
    small = cv2.resize(gray, (size, size))

    # Spectral residual
    fft = np.fft.fft2(small)
    log_mag = np.log(np.abs(fft) + 1e-8)
    # Smooth log magnitude with a 3×3 mean filter
    kernel = np.ones((3, 3), np.float32) / 9
    avg_log_mag = cv2.filter2D(log_mag, -1, kernel)
    residual = log_mag - avg_log_mag
    phase = np.angle(fft)
    # Reconstruct and compute saliency map
    sal = np.abs(np.fft.ifft2(np.exp(residual + 1j * phase))) ** 2
    sal = cv2.GaussianBlur(sal, (7, 7), 0)
    sal = (sal - sal.min()) / (sal.max() - sal.min() + 1e-8)

    thresh = sal.mean() + sal.std()
    mask = (sal > thresh).astype(np.uint8)
    if mask.sum() == 0:
        return None

    ys, xs = np.where(mask)
    x1, x2 = xs.min() / size, xs.max() / size
    y1, y2 = ys.min() / size, ys.max() / size

    bw = max(x2 - x1, 0.05)
    bh = max(y2 - y1, 0.05)
    return (x1, y1, bw, bh)


def _union_boxes(boxes: list[tuple[float, float, float, float]]) -> Optional[tuple[float, float, float, float]]:
    if not boxes:
        return None
    min_x = min(b[0] for b in boxes)
    min_y = min(b[1] for b in boxes)
    max_x = max(b[0] + b[2] for b in boxes)
    max_y = max(b[1] + b[3] for b in boxes)
    bw = max_x - min_x
    bh = max_y - min_y
    if bw <= 0 or bh <= 0:
        return None
    return (min_x, min_y, bw, bh)


def _run_yolo(image_path: str) -> tuple[list, list]:
    """Return (person_or_animal_boxes, all_boxes) as (x,y,w,h) normalized lists."""
    model = _get_yolo()
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
        object_boxes.append((x1, y1, x2 - x1, y2 - y1))
    return object_boxes


def detect_bounds_yolo_current(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Current algorithm: union of all object detections AND all saliency regions.
    Mirrors ImageCropper.m's detectSubjectBoundsUnionAll behaviour.
    """
    object_boxes = _run_yolo(image_path)
    sal = _spectral_saliency_bounds(image_path)
    all_boxes = list(object_boxes)
    if sal is not None:
        all_boxes.append(sal)
    return _union_boxes(all_boxes)


def detect_bounds_yolo_improved(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Improved algorithm: if any human/animal is detected, use only those boxes
    (skip saliency).  Fall back to spectral saliency when nothing is detected;
    if saliency returns bounds wider than 60% of the image in either dimension
    it is too loose to be useful, so a center 60%×60% crop is returned instead.

    Rationale: spectral saliency returns loose, background-inclusive bounds for
    images where the subject (plant, insect, fungus, etc.) is not visually
    distinct from the background.  A center crop is a reliable fallback —
    analysis of labeled iNaturalist data shows 98% of subjects lie within the
    central 60% of the frame.
    """
    object_boxes = _run_yolo(image_path)
    if object_boxes:
        return _union_boxes(object_boxes)
    # Fallback: saliency clamped to center crop when too loose
    sal = _spectral_saliency_bounds(image_path)
    if sal is not None and sal[2] <= 0.6 and sal[3] <= 0.6:
        return sal
    return (0.2, 0.2, 0.6, 0.6)


# ---------------------------------------------------------------------------
# ONNX backend — exact replica of detectSubjectBoundsYOLO() in ImageCropper.m
# Works with the 1-class YOLO-World INT8 models (yolov8n.onnx / yolov8n_finetuned.onnx)
# that detect any organism rather than the 80 fixed COCO classes.
# ---------------------------------------------------------------------------

_ONNX_CONF_THRESH = 0.05    # raw pre-sigmoid scores; matches YOLO_CONF_THRESH in .m
_ONNX_IOU_THRESH  = 0.45    # matches YOLO_IOU_THRESH
_ONNX_GATE_CONF   = 0.10    # matches YOLO_GATE_CONF
_ONNX_INPUT_SIZE  = 640

_onnx_session: dict = {}     # path → ort.InferenceSession


def _get_onnx_session(model_path: str):
    if model_path not in _onnx_session:
        try:
            import onnxruntime as ort  # type: ignore[import]
        except ImportError:
            sys.exit(
                "onnxruntime is required for the onnx backend.\n"
                "  pip install onnxruntime\n"
            )
        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = 2
        sess_opts.inter_op_num_threads = 1
        _onnx_session[model_path] = ort.InferenceSession(
            model_path, sess_opts, providers=["CPUExecutionProvider"]
        )
    return _onnx_session[model_path]


def _letterbox(img_bgr, size: int = 640):
    """Letterbox-resize to size×size on a gray-127 canvas.  Returns (canvas, padLeft, padTop, scale)."""
    import cv2
    import numpy as np
    h, w = img_bgr.shape[:2]
    scale = min(size / w, size / h)
    nw, nh = int(w * scale), int(h * scale)
    pad_left = (size - nw) / 2
    pad_top  = (size - nh) / 2
    canvas = np.full((size, size, 3), 127, dtype=np.uint8)
    resized = cv2.resize(img_bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas[int(pad_top):int(pad_top)+nh, int(pad_left):int(pad_left)+nw] = resized
    return canvas, pad_left, pad_top, scale


def _onnx_nms_union(dets):
    """Greedy NMS then union of boxes at ≥ 50% of best confidence.  Returns (x1,y1,x2,y2)."""
    import numpy as np
    dets = sorted(dets, key=lambda d: d[4], reverse=True)
    suppressed = [False] * len(dets)
    kept = []
    for i, d in enumerate(dets):
        if suppressed[i]:
            continue
        kept.append(i)
        for j in range(i + 1, len(dets)):
            if suppressed[j]:
                continue
            ix1 = max(d[0], dets[j][0]); iy1 = max(d[1], dets[j][1])
            ix2 = min(d[2], dets[j][2]); iy2 = min(d[3], dets[j][3])
            inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
            a1 = (d[2]-d[0])*(d[3]-d[1]); a2 = (dets[j][2]-dets[j][0])*(dets[j][3]-dets[j][1])
            iou_val = inter / (a1 + a2 - inter + 1e-8)
            if iou_val > _ONNX_IOU_THRESH:
                suppressed[j] = True
    if not kept:
        return None
    best_conf = dets[kept[0]][4]
    if best_conf < _ONNX_GATE_CONF:
        return None
    conf_threshold = 0.40 * best_conf
    ux1, uy1, ux2, uy2 = 1e9, 1e9, -1e9, -1e9
    used = 0
    for i in kept:
        if dets[i][4] < conf_threshold:
            continue
        ux1 = min(ux1, dets[i][0]); uy1 = min(uy1, dets[i][1])
        ux2 = max(ux2, dets[i][2]); uy2 = max(uy2, dets[i][3])
        used += 1
    if used == 0:
        ux1, uy1, ux2, uy2 = dets[kept[0]][:4]
    return (ux1, uy1, ux2, uy2)


def detect_bounds_onnx(image_path: str, model_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Exact Python replica of detectSubjectBoundsYOLO() in ImageCropper.m.
    Uses the 1-class YOLO-World ONNX model (detects any organism).
    Falls back to center 60%×60% when YOLO is uncertain or finds nothing prominent.
    """
    try:
        import cv2
        import numpy as np
    except ImportError:
        sys.exit("opencv-python-headless is required for the onnx backend.")

    img = cv2.imread(image_path)
    if img is None:
        return None
    img_h, img_w = img.shape[:2]

    canvas, pad_left, pad_top, scale = _letterbox(img)
    # BGR → RGB, CHW, float32, 0–1
    rgb = canvas[:, :, ::-1].astype(np.float32) / 255.0
    tensor = np.ascontiguousarray(rgb.transpose(2, 0, 1)[np.newaxis])

    sess = _get_onnx_session(model_path)
    out = sess.run(None, {"images": tensor})[0]   # [1, 5, 8400]
    out = out[0]  # [5, 8400]
    num_preds = out.shape[1]

    dets = []
    for j in range(num_preds):
        conf = float(out[4, j])
        if conf < _ONNX_CONF_THRESH:
            continue
        cx, cy, bw, bh = float(out[0,j]), float(out[1,j]), float(out[2,j]), float(out[3,j])
        dets.append((cx - bw/2, cy - bh/2, cx + bw/2, cy + bh/2, conf))

    if not dets:
        # No detection → center fallback
        sal = _spectral_saliency_bounds(image_path)
        if sal is not None and sal[2] <= 0.6 and sal[3] <= 0.6:
            return sal
        return (0.2, 0.2, 0.6, 0.6)

    result = _onnx_nms_union(dets)
    if result is None:
        # Below gate — uncertain; use saliency / center fallback
        sal = _spectral_saliency_bounds(image_path)
        if sal is not None and sal[2] <= 0.6 and sal[3] <= 0.6:
            return sal
        return (0.2, 0.2, 0.6, 0.6)

    ux1, uy1, ux2, uy2 = result
    x = max(0.0, min(1.0, (ux1 - pad_left) / scale / img_w))
    y = max(0.0, min(1.0, (uy1 - pad_top)  / scale / img_h))
    w = max(0.01, min(1.0 - x, (ux2 - ux1) / scale / img_w))
    h = max(0.01, min(1.0 - y, (uy2 - uy1) / scale / img_h))
    return (x, y, w, h)


_REPO_ROOT_FOR_ONNX = Path(__file__).parent.parent
_DEFAULT_ONNX_MODEL = str(_REPO_ROOT_FOR_ONNX / "ios" / "iNaturalistReactNative" / "yolov8n.onnx")
_FINETUNED_ONNX_MODEL = str(_REPO_ROOT_FOR_ONNX / "ios" / "iNaturalistReactNative" / "yolov8n_finetuned.onnx")


# ---------------------------------------------------------------------------
# Apple Vision detection via PyObjC (macOS only)
# ---------------------------------------------------------------------------

def detect_bounds_vision(image_path: str) -> Optional[tuple[float, float, float, float]]:
    """
    Run the same Vision requests as ImageCropper.m and return the union
    bounding box as (x, y, width, height) in top-left normalised coords,
    or None if nothing was detected.
    """
    try:
        import objc  # noqa: F401
    except ImportError:
        sys.exit("PyObjC is required. Install with:  pip3 install pyobjc\n")

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
                      bb.size.width, bb.size.height))

    if has_animals:
        for obs in (animal_req.results() or []):
            if obs.confidence() < 0.3:
                continue
            bb = obs.boundingBox()
            boxes.append((bb.origin.x, bb.origin.y,
                          bb.size.width, bb.size.height))

    for obs in (saliency_req.results() or []):
        for rect_obs in (obs.salientObjects() or []):
            bb = rect_obs.boundingBox()
            boxes.append((bb.origin.x, bb.origin.y,
                          bb.size.width, bb.size.height))

    if not boxes:
        return None

    result = _union_boxes(boxes)
    if result is None:
        return None
    bx, by, bw, bh = result
    # Vision uses bottom-left origin; flip Y to top-left to match the app
    return (bx, 1.0 - by - bh, bw, bh)


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

    if "inaturalist" in key or "amazonaws.com" in key:
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
        # Fallback to the original URL size
        dest2 = cache_dir / (name[:-4] + "_fallback.jpg")
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
    bounds_current: Optional[tuple[float, float, float, float]]
    bounds_improved: Optional[tuple[float, float, float, float]]
    image_width: int = 0
    image_height: int = 0


@dataclass
class PaddingResult:
    padding: float
    mean_recall: float
    mean_precision: float
    mean_score: float
    pct_full_recall: float
    scores: list[float] = field(default_factory=list)


def _evaluate_one(entries: list[EvalEntry], paddings: list[float],
                  use_improved: bool) -> list[PaddingResult]:
    detected = [e for e in entries
                if (e.bounds_improved if use_improved else e.bounds_current) is not None]
    results = []
    for pad in paddings:
        preds = []
        for e in detected:
            b = e.bounds_improved if use_improved else e.bounds_current
            preds.append(bounds_to_crop(*b, pad, e.image_width, e.image_height))  # type: ignore[arg-type]
        recalls = [recall(p, e.truth) for p, e in zip(preds, detected)]
        precisions = [precision(p, e.truth) for p, e in zip(preds, detected)]
        scores = [weighted_score(p, e.truth) for p, e in zip(preds, detected)]
        n = len(scores)
        mean_r = sum(recalls) / n if n else 0.0
        mean_p = sum(precisions) / n if n else 0.0
        mean_s = sum(scores) / n if n else 0.0
        pct_full = sum(1 for r in recalls if r >= 0.999) / n * 100 if n else 0.0
        results.append(PaddingResult(pad, mean_r, mean_p, mean_s, pct_full, scores))
    return results


def evaluate(entries: list[EvalEntry], paddings: list[float]) -> tuple[list[PaddingResult], list[PaddingResult]]:
    n_cur = sum(1 for e in entries if e.bounds_current is not None)
    n_imp = sum(1 for e in entries if e.bounds_improved is not None)
    print(f"Detection succeeded — current: {n_cur}/{len(entries)}, improved: {n_imp}/{len(entries)}\n")
    return (
        _evaluate_one(entries, paddings, use_improved=False),
        _evaluate_one(entries, paddings, use_improved=True),
    )


def _best(results: list[PaddingResult]) -> PaddingResult:
    return max(results, key=lambda r: r.mean_score)


def print_report(cur_results: list[PaddingResult], imp_results: list[PaddingResult],
                 entries: list[EvalEntry], current_padding: float) -> None:
    kept = sum(1 for e in entries if e.kept)
    print("=" * 80)
    print(f"Total: {len(entries)}  |  Photo kept: {kept} ({kept/len(entries)*100:.0f}%)")
    print(f"Score = {RECALL_WEIGHT:.0f}×recall + {PRECISION_WEIGHT:.0f}×precision  "
          f"(recall = % of truth inside AI crop; precision = % of AI crop inside truth)")
    print("=" * 80)

    for label, results in [("CURRENT algorithm (union all)", cur_results),
                           ("IMPROVED algorithm (saliency as fallback)", imp_results)]:
        best = _best(results)
        print(f"\n── {label} ──")
        print(f"  {'Padding':>8}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}  {'100% recall':>12}")
        print("  " + "-" * 55)
        for r in results:
            cur = " ◀ current" if abs(r.padding - current_padding) < 1e-6 else ""
            star = " ★ BEST" if r is best else ""
            print(f"  {r.padding:>8.2f}  {r.mean_recall:>8.3f}  {r.mean_precision:>10.3f}  "
                  f"{r.mean_score:>7.3f}  {r.pct_full_recall:>9.1f}%{cur}{star}")
        print(f"\n  Best padding: {best.padding}  "
              f"(recall={best.mean_recall:.3f}, precision={best.mean_precision:.3f}, "
              f"score={best.mean_score:.3f})")

    best_cur = _best(cur_results)
    best_imp = _best(imp_results)
    delta = best_imp.mean_score - best_cur.mean_score
    delta_r = best_imp.mean_recall - best_cur.mean_recall
    delta_p = best_imp.mean_precision - best_cur.mean_precision

    print("\n" + "=" * 80)
    print("SUMMARY — best padding for each algorithm")
    print(f"  Current  : padding={best_cur.padding}  "
          f"score={best_cur.mean_score:.3f}  "
          f"recall={best_cur.mean_recall:.3f}  precision={best_cur.mean_precision:.3f}")
    print(f"  Improved : padding={best_imp.padding}  "
          f"score={best_imp.mean_score:.3f}  "
          f"recall={best_imp.mean_recall:.3f}  precision={best_imp.mean_precision:.3f}")
    sign = "+" if delta >= 0 else ""
    print(f"  Δ score  : {sign}{delta:.3f}  "
          f"(Δ recall {sign}{delta_r:.3f}, Δ precision {sign}{delta_p:.3f})")

    if delta > 0:
        print(f"\nRecommendation: adopt the improved algorithm and set padding → {best_imp.padding}")
        print("  src/sharedHelpers/subjectDetectionModels.ts  (SUBJECT_DETECTION_MODEL_PADDING)")
        print("  ios/iNaturalistReactNative/ImageCropper.m   (detectSubjectBoundsUnionAll)")
    elif abs(delta) < 0.005:
        print("\nAlgorithms perform similarly; no change needed beyond padding.")
    else:
        print("\nCurrent algorithm is better; consider keeping it.")
    print()


# ---------------------------------------------------------------------------
# Firebase / .env helpers
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent
_ENV_FILE = _REPO_ROOT / ".env"
_DEFAULT_FIREBASE_URL = "https://inaturalist-9001d-default-rtdb.firebaseio.com"


def _load_env() -> None:
    if not _ENV_FILE.is_file():
        return
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())


def _fetch_firebase(base_url: str) -> list:
    url = f"{base_url.rstrip('/')}/crop_log.json"
    print(f"Fetching crop log from {url} …")
    req = urllib.request.Request(url, headers={"User-Agent": "iNat-crop-eval/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read())
    if data is None:
        sys.exit("Firebase returned null — no crop log data found.")
    print(f"  Got {len(data)} entries.\n")
    return data


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("feedback_json", nargs="?",
                        help="Path to crop_training.json (omit to read from Firebase)")
    parser.add_argument("--photos-dir", metavar="DIR",
                        help="Folder of Apple Photos exports (for file:// entries)")
    parser.add_argument("--paddings",
                        default="0.00,0.05,0.08,0.10,0.12,0.15,0.18,0.20,0.25,0.30",
                        help="Comma-separated padding values to test")
    parser.add_argument("--cache-dir", default=None,
                        help="Cache directory for downloaded images")
    parser.add_argument("--current-padding", type=float, default=0.0,
                        help="Padding currently in use (marks it in the report)")
    parser.add_argument("--backend", choices=["yolo", "vision", "onnx", "onnx-finetuned"], default="onnx",
                        help="Detection backend: onnx (default, uses ios/yolov8n.onnx — 1-class YOLO-World, "
                             "matches iOS app exactly), onnx-finetuned (ios/yolov8n_finetuned.onnx), "
                             "yolo (yolov8n.pt, 80 COCO classes), vision (macOS only)")
    parser.add_argument("--onnx-model", default=None,
                        help="Path to a custom ONNX model (overrides --backend onnx selection)")
    args = parser.parse_args()

    paddings = [float(p.strip()) for p in args.paddings.split(",")]
    photos_dir = Path(args.photos_dir).expanduser() if args.photos_dir else None

    if args.feedback_json:
        with open(args.feedback_json) as f:
            raw = json.load(f)
    else:
        _load_env()
        base_url = os.environ.get("CROP_LOG_FIREBASE_URL", _DEFAULT_FIREBASE_URL).strip()
        raw = _fetch_firebase(base_url)

    # Support two formats:
    #   1. Array of {url, x, y, w, h}  (crop_training.json / Firebase)
    #   2. Object keyed by URL with {crop: {x,y,w,h}, kept: bool}  (old feedback export)
    if isinstance(raw, list):
        entries_raw = [(entry["url"], {"crop": entry, "kept": True}) for entry in raw]
    else:
        entries_raw = [
            (key, val) for key, val in raw.items()
            if val.get("crop") is not None
        ]
    print(f"Loaded {len(entries_raw)} entries with crop data.\n")

    if args.backend == "vision":
        detect_current = detect_bounds_vision
        detect_improved = detect_bounds_vision  # vision backend: only one algo
    elif args.backend in ("onnx", "onnx-finetuned") or args.onnx_model:
        model_path = (args.onnx_model or
                      (_FINETUNED_ONNX_MODEL if args.backend == "onnx-finetuned"
                       else _DEFAULT_ONNX_MODEL))
        detect_current = lambda p: detect_bounds_onnx(p, model_path)  # noqa: E731
        detect_improved = detect_current
    else:
        detect_current = detect_bounds_yolo_current
        detect_improved = detect_bounds_yolo_improved

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
            bounds_cur = detect_current(image_path)
            if args.backend == "yolo":
                bounds_imp = detect_improved(image_path)
            else:
                bounds_imp = bounds_cur  # vision/onnx: single algorithm
            if bounds_cur is None:
                print("  ↳ current: no detection")
            if bounds_imp is None:
                print("  ↳ improved: no detection")
            eval_entries.append(
                EvalEntry(key, truth, kept, bounds_cur, bounds_imp, img_w, img_h)
            )

        if skipped:
            print(f"\nSkipped {skipped} entries (image not found).")
        if not eval_entries:
            sys.exit("No images could be evaluated.")

        cur_results, imp_results = evaluate(eval_entries, paddings)
        print_report(cur_results, imp_results, eval_entries, current_padding=args.current_padding)

        # CSV export
        csv_path = (Path(args.feedback_json).with_suffix(".eval.csv")
                    if args.feedback_json
                    else _REPO_ROOT / "crop_training.eval.csv")
        with open(csv_path, "w") as csvf:
            header = "key,truth_x,truth_y,truth_w,truth_h,kept,detected_cur,detected_imp"
            for p in paddings:
                header += f",cur_recall_{p:.2f},cur_prec_{p:.2f},cur_score_{p:.2f}"
                header += f",imp_recall_{p:.2f},imp_prec_{p:.2f},imp_score_{p:.2f}"
            csvf.write(header + "\n")
            for e in eval_entries:
                row = (f"{e.key},{e.truth.x:.4f},{e.truth.y:.4f},"
                       f"{e.truth.w:.4f},{e.truth.h:.4f},{int(e.kept)},"
                       f"{int(e.bounds_current is not None)},"
                       f"{int(e.bounds_improved is not None)}")
                for p in paddings:
                    if e.bounds_current is not None:
                        pred_c = bounds_to_crop(*e.bounds_current, p, e.image_width, e.image_height)
                        row += (f",{recall(pred_c, e.truth):.4f}"
                                f",{precision(pred_c, e.truth):.4f}"
                                f",{weighted_score(pred_c, e.truth):.4f}")
                    else:
                        row += ",,,"
                    if e.bounds_improved is not None:
                        pred_i = bounds_to_crop(*e.bounds_improved, p, e.image_width, e.image_height)
                        row += (f",{recall(pred_i, e.truth):.4f}"
                                f",{precision(pred_i, e.truth):.4f}"
                                f",{weighted_score(pred_i, e.truth):.4f}")
                    else:
                        row += ",,,"
                csvf.write(row + "\n")
        print(f"Per-entry CSV: {csv_path}\n")


if __name__ == "__main__":
    main()
