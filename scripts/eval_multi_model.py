#!/usr/bin/env python3
"""
Multi-model subject detector evaluation for iNaturalist.

Tests and compares:
  1. deployed    — ios/iNaturalistReactNative/yolov8n.onnx (current 1-class)
  2. finetuned   — ios/iNaturalistReactNative/yolov8n_finetuned.onnx (1-class)
  3. worldv2int8 — yolov8s-worldv2-int8.onnx (16-class, quantized)
  4. worldv2s    — yolov8s-worldv2.pt with iNaturalist text prompts
  5. yolov8s     — yolov8s.pt (standard COCO, more classes than nano)

Each backend is run with both:
  • current  strategy: union(objects, saliency)
  • improved strategy: objects if found, else saliency

Scoring: weighted_score = (2*recall + 1*precision) / 3

Usage:
    python3 scripts/eval_multi_model.py
    python3 scripts/eval_multi_model.py --cache-dir /tmp/inat-img-cache
    python3 scripts/eval_multi_model.py --models deployed,finetuned
    python3 scripts/eval_multi_model.py --limit 50  # quick test on first 50 images
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
# Metrics — same as evaluate_subject_detector.py
# ---------------------------------------------------------------------------

@dataclass
class Crop:
    x: float
    y: float
    w: float
    h: float


def bounds_to_crop(bx, by, bw, bh, padding, image_width=0, image_height=0):
    if bw <= 0 or bh <= 0:
        return Crop(0, 0, 1, 1)
    if image_width > 0 and image_height > 0:
        padded_w = bw * (1 + padding)
        padded_h = bh * (1 + padding)
        pixel_side = max(padded_w * image_width, padded_h * image_height)
        w = pixel_side / image_width
        h = pixel_side / image_height
        cx = bx + bw / 2
        cy = by + bh / 2
        x = (max(0.0, min(1.0 - w, cx - w / 2)) if w <= 1.0 else cx - w / 2)
        y = (max(0.0, min(1.0 - h, cy - h / 2)) if h <= 1.0 else cy - h / 2)
        return Crop(x, y, w, h)
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
    w2 = max(0.05, min(1.0, side))
    h2 = max(0.05, min(1.0, side))
    x2 = max(0.0, min(1.0 - w2, x))
    y2 = max(0.0, min(1.0 - h2, y))
    return Crop(x2, y2, w2, h2)


def intersection_area(a, b):
    x1 = max(a.x, b.x)
    y1 = max(a.y, b.y)
    x2 = min(a.x + a.w, b.x + b.w)
    y2 = min(a.y + a.h, b.y + b.h)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return (x2 - x1) * (y2 - y1)


def recall(pred, truth):
    truth_area = truth.w * truth.h
    if truth_area <= 0:
        return 0.0
    return intersection_area(pred, truth) / truth_area


def precision(pred, truth):
    pred_area = pred.w * pred.h
    if pred_area <= 0:
        return 0.0
    return intersection_area(pred, truth) / pred_area


def weighted_score(pred, truth):
    r = recall(pred, truth)
    p = precision(pred, truth)
    return (2.0 * r + 1.0 * p) / 3.0


# ---------------------------------------------------------------------------
# Saliency fallback (same as evaluate_subject_detector.py)
# ---------------------------------------------------------------------------

def _spectral_saliency_bounds(image_path):
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    img = cv2.imread(image_path)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    size = 64
    small = cv2.resize(gray, (size, size))
    fft = np.fft.fft2(small)
    log_mag = np.log(np.abs(fft) + 1e-8)
    kernel = np.ones((3, 3), np.float32) / 9
    avg_log_mag = cv2.filter2D(log_mag, -1, kernel)
    residual = log_mag - avg_log_mag
    phase = np.angle(fft)
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


def _union_boxes(boxes):
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


# ---------------------------------------------------------------------------
# ONNX inference — mirrors iOS ImageCropper.m logic exactly
# ---------------------------------------------------------------------------

YOLO_CONF_THRESH = 0.05   # pre-NMS filter
YOLO_GATE_CONF   = 0.25   # minimum to trust the detection
YOLO_IOU_THRESH  = 0.45
YOLO_UNION_THRESH = 0.60  # include box if >= 60% of best box's conf
YOLO_UNION_MAX_K  = 3

_ort_sessions: dict[str, object] = {}


def _get_ort_session(model_path: str):
    if model_path not in _ort_sessions:
        import onnxruntime as ort
        sess = ort.InferenceSession(model_path)
        _ort_sessions[model_path] = sess
    return _ort_sessions[model_path]


def _preprocess_image_for_yolo(image_path: str, size: int = 640):
    """Returns (tensor CHW float32, pad_left, pad_top, scale, orig_w, orig_h)."""
    import cv2
    import numpy as np
    img = cv2.imread(image_path)
    if img is None:
        return None
    img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img.shape[:2]
    s = min(size / w, size / h)
    nw, nh = int(round(w * s)), int(round(h * s))
    pad_left = (size - nw) / 2.0
    pad_top  = (size - nh) / 2.0
    resized = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((size, size, 3), 127, dtype=np.uint8)
    x0, y0 = int(pad_left), int(pad_top)
    canvas[y0:y0 + nh, x0:x0 + nw] = resized
    tensor = canvas.astype(np.float32) / 255.0
    tensor = tensor.transpose(2, 0, 1)[np.newaxis]  # 1,3,H,W
    return tensor, pad_left, pad_top, s, w, h


def _decode_yolo_output_1class(output, pad_left, pad_top, scale, orig_w, orig_h):
    """
    Decode [1, 5, 8400] output (custom 1-class model), same logic as ImageCropper.m.
    Returns list of (x, y, w, h) normalized boxes that pass NMS + gate.
    """
    import numpy as np
    out = output[0]  # (5, 8400)
    scores = out[4]  # objectness
    mask = scores >= YOLO_CONF_THRESH
    if not mask.any():
        return []

    cx = out[0][mask]
    cy = out[1][mask]
    bw = out[2][mask]
    bh = out[3][mask]
    sc = scores[mask]

    x1s = cx - bw / 2
    y1s = cy - bh / 2
    x2s = cx + bw / 2
    y2s = cy + bh / 2

    # Greedy NMS
    order = np.argsort(-sc)
    x1s, y1s, x2s, y2s, sc = x1s[order], y1s[order], x2s[order], y2s[order], sc[order]
    suppressed = np.zeros(len(sc), dtype=bool)
    kept_idxs = []
    for i in range(len(sc)):
        if suppressed[i]:
            continue
        kept_idxs.append(i)
        ix1 = np.maximum(x1s[i], x1s[i+1:])
        iy1 = np.maximum(y1s[i], y1s[i+1:])
        ix2 = np.minimum(x2s[i], x2s[i+1:])
        iy2 = np.minimum(y2s[i], y2s[i+1:])
        inter = np.maximum(0, ix2 - ix1) * np.maximum(0, iy2 - iy1)
        area_i = (x2s[i] - x1s[i]) * (y2s[i] - y1s[i])
        area_j = (x2s[i+1:] - x1s[i+1:]) * (y2s[i+1:] - y1s[i+1:])
        iou_vals = inter / (area_i + area_j - inter + 1e-6)
        suppressed[i+1:][iou_vals > YOLO_IOU_THRESH] = True

    if not kept_idxs:
        return []

    best_conf = sc[kept_idxs[0]]
    if best_conf < YOLO_GATE_CONF:
        return []

    conf_thresh = YOLO_UNION_THRESH * best_conf
    boxes = []
    for idx in kept_idxs[:YOLO_UNION_MAX_K]:
        if sc[idx] < conf_thresh:
            break
        # Map back to image coords
        x = (x1s[idx] - pad_left) / scale / orig_w
        y = (y1s[idx] - pad_top)  / scale / orig_h
        w = (x2s[idx] - x1s[idx]) / scale / orig_w
        h = (y2s[idx] - y1s[idx]) / scale / orig_h
        x = max(0.0, min(1.0, x))
        y = max(0.0, min(1.0, y))
        w = max(0.01, min(1.0 - x, w))
        h = max(0.01, min(1.0 - y, h))
        boxes.append((x, y, w, h))
    return boxes


def _decode_yolo_output_multiclass(output, pad_left, pad_top, scale, orig_w, orig_h,
                                   min_conf=0.25):
    """
    Decode [1, 4+N, 8400] multi-class output.
    Takes max confidence across all classes, same NMS + gate logic.
    """
    import numpy as np
    out = output[0]  # (4+N, 8400)
    num_classes = out.shape[0] - 4
    scores = out[4:].max(axis=0)  # max confidence across all classes
    mask = scores >= YOLO_CONF_THRESH
    if not mask.any():
        return []

    cx = out[0][mask]
    cy = out[1][mask]
    bw = out[2][mask]
    bh = out[3][mask]
    sc = scores[mask]

    x1s = cx - bw / 2
    y1s = cy - bh / 2
    x2s = cx + bw / 2
    y2s = cy + bh / 2

    # Filter by min_conf first
    valid = sc >= min_conf
    if not valid.any():
        # Still do NMS but with lower gate
        pass

    # Greedy NMS
    order = np.argsort(-sc)
    x1s, y1s, x2s, y2s, sc = x1s[order], y1s[order], x2s[order], y2s[order], sc[order]
    suppressed = np.zeros(len(sc), dtype=bool)
    kept_idxs = []
    for i in range(len(sc)):
        if suppressed[i]:
            continue
        kept_idxs.append(i)
        ix1 = np.maximum(x1s[i], x1s[i+1:])
        iy1 = np.maximum(y1s[i], y1s[i+1:])
        ix2 = np.minimum(x2s[i], x2s[i+1:])
        iy2 = np.minimum(y2s[i], y2s[i+1:])
        inter = np.maximum(0, ix2 - ix1) * np.maximum(0, iy2 - iy1)
        area_i = (x2s[i] - x1s[i]) * (y2s[i] - y1s[i])
        area_j = (x2s[i+1:] - x1s[i+1:]) * (y2s[i+1:] - y1s[i+1:])
        iou_vals = inter / (area_i + area_j - inter + 1e-6)
        suppressed[i+1:][iou_vals > YOLO_IOU_THRESH] = True

    if not kept_idxs:
        return []

    best_conf = sc[kept_idxs[0]]
    if best_conf < YOLO_GATE_CONF:
        return []

    conf_thresh = YOLO_UNION_THRESH * best_conf
    boxes = []
    for idx in kept_idxs[:YOLO_UNION_MAX_K]:
        if sc[idx] < conf_thresh:
            break
        x = (x1s[idx] - pad_left) / scale / orig_w
        y = (y1s[idx] - pad_top)  / scale / orig_h
        w = (x2s[idx] - x1s[idx]) / scale / orig_w
        h = (y2s[idx] - y1s[idx]) / scale / orig_h
        x = max(0.0, min(1.0, x))
        y = max(0.0, min(1.0, y))
        w = max(0.01, min(1.0 - x, w))
        h = max(0.01, min(1.0 - y, h))
        boxes.append((x, y, w, h))
    return boxes


def _detect_onnx_1class(image_path, model_path, use_saliency_fallback=True, union_with_saliency=False):
    """Detect using a 1-class ONNX model (deployed or finetuned)."""
    prep = _preprocess_image_for_yolo(image_path)
    if prep is None:
        return None
    tensor, pad_left, pad_top, scale, orig_w, orig_h = prep
    sess = _get_ort_session(model_path)
    output = sess.run(None, {"images": tensor})
    boxes = _decode_yolo_output_1class(output[0], pad_left, pad_top, scale, orig_w, orig_h)

    if union_with_saliency:
        sal = _spectral_saliency_bounds(image_path)
        all_boxes = list(boxes)
        if sal is not None:
            all_boxes.append(sal)
        return _union_boxes(all_boxes)
    else:
        if boxes:
            return _union_boxes(boxes)
        if use_saliency_fallback:
            return _spectral_saliency_bounds(image_path)
        return None


def _detect_onnx_multiclass(image_path, model_path, union_with_saliency=False):
    """Detect using a multi-class ONNX model (WorldV2-int8 etc.)."""
    prep = _preprocess_image_for_yolo(image_path)
    if prep is None:
        return None
    tensor, pad_left, pad_top, scale, orig_w, orig_h = prep
    sess = _get_ort_session(model_path)
    output = sess.run(None, {"images": tensor})
    boxes = _decode_yolo_output_multiclass(output[0], pad_left, pad_top, scale, orig_w, orig_h)

    if union_with_saliency:
        sal = _spectral_saliency_bounds(image_path)
        all_boxes = list(boxes)
        if sal is not None:
            all_boxes.append(sal)
        return _union_boxes(all_boxes)
    else:
        if boxes:
            return _union_boxes(boxes)
        return _spectral_saliency_bounds(image_path)


# COCO animal class IDs (same as original eval script)
_COCO_ANIMAL_CLASSES = {14,15,16,17,18,19,20,21,22,23}  # bird..giraffe
_COCO_PERSON_CLASS = 0
_COCO_MIN_CONF = 0.25

_yolo_pt_models: dict[str, object] = {}


def _get_yolo_pt(model_name):
    if model_name not in _yolo_pt_models:
        from ultralytics import YOLO
        _yolo_pt_models[model_name] = YOLO(model_name)
    return _yolo_pt_models[model_name]


_world_model = None
INAT_CLASSES = [
    "animal", "insect", "bird", "fish", "plant", "flower",
    "mushroom", "fungus", "reptile", "spider", "butterfly",
    "bee", "snake", "frog", "amphibian", "invertebrate",
]


def _get_world_model(model_path):
    global _world_model
    if _world_model is None:
        from ultralytics import YOLOWorld
        m = YOLOWorld(model_path)
        m.set_classes(INAT_CLASSES)
        _world_model = m
    return _world_model


def _run_coco_yolo(image_path, model_name, include_all=False):
    """Run standard COCO YOLO, filter to person+animals (or all if include_all)."""
    model = _get_yolo_pt(model_name)
    results = model(image_path, verbose=False)[0]
    boxes = []
    for box in results.boxes:
        cls = int(box.cls)
        conf = float(box.conf)
        if conf < _COCO_MIN_CONF:
            continue
        if not include_all and cls != _COCO_PERSON_CLASS and cls not in _COCO_ANIMAL_CLASSES:
            continue
        x1, y1, x2, y2 = [float(v) for v in box.xyxyn[0]]
        boxes.append((x1, y1, x2 - x1, y2 - y1))
    return boxes


def _run_world_yolo(image_path, model_path):
    """Run YOLOWorld with iNaturalist text prompts."""
    model = _get_world_model(model_path)
    results = model(image_path, verbose=False)[0]
    boxes = []
    for box in results.boxes:
        conf = float(box.conf)
        if conf < _COCO_MIN_CONF:
            continue
        x1, y1, x2, y2 = [float(v) for v in box.xyxyn[0]]
        boxes.append((x1, y1, x2 - x1, y2 - y1))
    return boxes


# ---------------------------------------------------------------------------
# Backend registry
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.parent


def make_backends(requested: list[str]):
    """
    Returns dict: name -> (detect_current_fn, detect_improved_fn)
    Each fn: (image_path: str) -> Optional[(x,y,w,h)]
    """
    available = {
        "deployed": (
            lambda p: _detect_onnx_1class(p, str(REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"),
                                          use_saliency_fallback=True, union_with_saliency=True),
            lambda p: _detect_onnx_1class(p, str(REPO_ROOT / "ios/iNaturalistReactNative/yolov8n.onnx"),
                                          use_saliency_fallback=True, union_with_saliency=False),
        ),
        "finetuned": (
            lambda p: _detect_onnx_1class(p, str(REPO_ROOT / "ios/iNaturalistReactNative/yolov8n_finetuned.onnx"),
                                          use_saliency_fallback=True, union_with_saliency=True),
            lambda p: _detect_onnx_1class(p, str(REPO_ROOT / "ios/iNaturalistReactNative/yolov8n_finetuned.onnx"),
                                          use_saliency_fallback=True, union_with_saliency=False),
        ),
        "worldv2int8": (
            lambda p: _detect_onnx_multiclass(p, str(REPO_ROOT / "yolov8s-worldv2-int8.onnx"),
                                               union_with_saliency=True),
            lambda p: _detect_onnx_multiclass(p, str(REPO_ROOT / "yolov8s-worldv2-int8.onnx"),
                                               union_with_saliency=False),
        ),
        "worldv2s": (
            lambda p: (_union_boxes(_run_world_yolo(p, str(REPO_ROOT / "yolov8s-worldv2.pt")) +
                       ([_spectral_saliency_bounds(p)] if _spectral_saliency_bounds(p) else []))
                       if True else None),
            lambda p: (_union_boxes(_run_world_yolo(p, str(REPO_ROOT / "yolov8s-worldv2.pt")))
                       or _spectral_saliency_bounds(p)),
        ),
        "yolov8s": (
            lambda p: (_union_boxes(_run_coco_yolo(p, str(REPO_ROOT / "yolov8s.pt")) +
                       ([_spectral_saliency_bounds(p)] if _spectral_saliency_bounds(p) else []))
                       if True else None),
            lambda p: (_union_boxes(_run_coco_yolo(p, str(REPO_ROOT / "yolov8s.pt")))
                       or _spectral_saliency_bounds(p)),
        ),
    }

    if requested:
        return {k: v for k, v in available.items() if k in requested}
    return available


# ---------------------------------------------------------------------------
# Image acquisition (same as evaluate_subject_detector.py)
# ---------------------------------------------------------------------------

INATURALIST_SIZE_RE = re.compile(
    r"(https://[^?]+/photos/\d+/)(square|small|medium|large|original)(\.jpe?g)",
    re.IGNORECASE,
)


def inaturalist_original_url(url):
    m = INATURALIST_SIZE_RE.match(url)
    return m.group(1) + "original" + m.group(3) if m else url


def download_image(url, dest):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "iNat-crop-eval/1.0"})
        with urllib.request.urlopen(req, timeout=30) as resp, open(dest, "wb") as f:
            f.write(resp.read())
        return True
    except Exception as exc:
        print(f"  ↳ download failed: {exc}")
        return False


def resolve_image(key, cache_dir):
    if key.startswith("file://"):
        local = key[len("file://"):]
        if os.path.isfile(local):
            return local
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
        # Fallback to S3 mirror
        if "static.inaturalist.org" in orig_url:
            mirror = orig_url.replace("static.inaturalist.org",
                                      "inaturalist-open-data.s3.amazonaws.com", 1)
            dest2 = cache_dir / (name[:-4] + "_mirror.jpg")
            if dest2.is_file():
                return str(dest2)
            if download_image(mirror, str(dest2)):
                return str(dest2)
        return None
    return None


def get_image_size(image_path):
    try:
        from PIL import Image as PILImage
        with PILImage.open(image_path) as img:
            return img.size
    except Exception:
        pass
    return (0, 0)


# ---------------------------------------------------------------------------
# Evaluation core
# ---------------------------------------------------------------------------

@dataclass
class Entry:
    key: str
    truth: Crop
    image_path: Optional[str]
    image_width: int = 0
    image_height: int = 0


@dataclass
class PaddingResult:
    padding: float
    mean_recall: float
    mean_precision: float
    mean_score: float
    pct_full_recall: float
    n: int


def evaluate_strategy(entries, get_bounds_fn, paddings):
    """Run detection + evaluate for a list of entries and a detection function."""
    detected = []
    for e in entries:
        if e.image_path is None:
            detected.append(None)
            continue
        b = get_bounds_fn(e.image_path)
        detected.append(b)

    results = []
    for pad in paddings:
        scores, recalls, precs = [], [], []
        for e, b in zip(entries, detected):
            if b is None:
                continue
            pred = bounds_to_crop(*b, pad, e.image_width, e.image_height)
            r = recall(pred, e.truth)
            p = precision(pred, e.truth)
            s = (2.0 * r + p) / 3.0
            recalls.append(r)
            precs.append(p)
            scores.append(s)
        n = len(scores)
        if n == 0:
            results.append(PaddingResult(pad, 0, 0, 0, 0, 0))
            continue
        results.append(PaddingResult(
            pad,
            sum(recalls) / n,
            sum(precs) / n,
            sum(scores) / n,
            sum(1 for r in recalls if r >= 0.999) / n * 100,
            n,
        ))
    return results


def best(results):
    return max(results, key=lambda r: r.mean_score)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("feedback_json", nargs="?", default="crop_training.json")
    parser.add_argument("--cache-dir", default="/tmp/inat-img-cache")
    parser.add_argument("--paddings", default="0.00,0.05,0.08,0.10,0.12,0.15,0.18,0.20,0.25,0.30")
    parser.add_argument("--models", default=None,
                        help="Comma-separated subset of: deployed,finetuned,worldv2int8,worldv2s,yolov8s")
    parser.add_argument("--limit", type=int, default=0, help="Limit to first N images (0=all)")
    args = parser.parse_args()

    paddings = [float(p.strip()) for p in args.paddings.split(",")]
    model_names = [m.strip() for m in args.models.split(",")] if args.models else None
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    with open(args.feedback_json) as f:
        raw = json.load(f)

    if isinstance(raw, list):
        entries_raw = [(e["url"], e) for e in raw]
    else:
        entries_raw = [(k, v["crop"]) for k, v in raw.items() if v.get("crop")]

    if args.limit:
        entries_raw = entries_raw[:args.limit]

    print(f"Loaded {len(entries_raw)} entries.\n")

    # Download all images once
    entries = []
    skipped = 0
    for i, (key, c) in enumerate(entries_raw, 1):
        if isinstance(c, dict) and "crop" in c:
            c = c["crop"]
        truth = Crop(c["x"], c["y"], c["w"], c["h"])
        short = key[-60:] if len(key) > 60 else key
        print(f"[{i}/{len(entries_raw)}] {short}")
        image_path = resolve_image(key, cache_dir)
        if not image_path:
            print("  ↳ skipped (not found)")
            skipped += 1
            entries.append(Entry(key, truth, None))
            continue
        iw, ih = get_image_size(image_path)
        entries.append(Entry(key, truth, image_path, iw, ih))

    if skipped:
        print(f"\nSkipped {skipped} entries.\n")

    backends = make_backends(model_names)

    all_results = {}  # name -> {"current": list[PaddingResult], "improved": list[PaddingResult]}
    for name, (cur_fn, imp_fn) in backends.items():
        print(f"\n{'='*60}")
        print(f"Running backend: {name}")
        print(f"{'='*60}")
        print("  [current strategy]")
        cur_results = evaluate_strategy(entries, cur_fn, paddings)
        print("  [improved strategy]")
        imp_results = evaluate_strategy(entries, imp_fn, paddings)
        all_results[name] = {"current": cur_results, "improved": imp_results}

    # Print summary table
    print("\n" + "=" * 80)
    print("SUMMARY — best score for each backend × strategy")
    print(f"  {'Backend':<16}  {'Strategy':<10}  {'Padding':>8}  {'Score':>7}  {'Recall':>7}  {'Precision':>10}  {'N':>5}")
    print("  " + "-" * 70)
    best_score = 0.0
    best_config = None
    for name, strats in all_results.items():
        for strat, results in strats.items():
            b = best(results)
            marker = ""
            if b.mean_score > best_score:
                best_score = b.mean_score
                best_config = (name, strat, b)
                marker = " ★"
            print(f"  {name:<16}  {strat:<10}  {b.padding:>8.2f}  {b.mean_score:>7.3f}  "
                  f"{b.mean_recall:>7.3f}  {b.mean_precision:>10.3f}  {b.n:>5}{marker}")

    print()
    if best_config:
        name, strat, b = best_config
        print(f"BEST: {name}/{strat}  padding={b.padding}  score={b.mean_score:.4f}  "
              f"recall={b.mean_recall:.4f}  precision={b.mean_precision:.4f}")

    # Detailed table per backend
    print("\n" + "=" * 80)
    print("DETAILED RESULTS PER PADDING")
    for name, strats in all_results.items():
        for strat, results in strats.items():
            b = best(results)
            print(f"\n── {name} / {strat} ──")
            print(f"  {'Padding':>8}  {'Recall':>8}  {'Precision':>10}  {'Score':>7}  {'100%recall':>10}")
            for r in results:
                star = " ★" if r is b else ""
                print(f"  {r.padding:>8.2f}  {r.mean_recall:>8.3f}  {r.mean_precision:>10.3f}  "
                      f"{r.mean_score:>7.3f}  {r.pct_full_recall:>9.1f}%{star}")

    # Save results JSON
    out_path = REPO_ROOT / "crop_training.multimodel_eval.json"
    save_data = {}
    for name, strats in all_results.items():
        save_data[name] = {}
        for strat, results in strats.items():
            save_data[name][strat] = [
                {"padding": r.padding, "recall": r.mean_recall,
                 "precision": r.mean_precision, "score": r.mean_score,
                 "pct_full_recall": r.pct_full_recall, "n": r.n}
                for r in results
            ]
    with open(out_path, "w") as f:
        json.dump(save_data, f, indent=2)
    print(f"\nResults saved to: {out_path}\n")

    return best_config


if __name__ == "__main__":
    main()
