"""High-level API: prepare artifacts, run saliency, optional PNG export."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import numpy as np
import torch
from PIL import Image

from inat_vision_saliency.download import ensure_tflite
from inat_vision_saliency.model import load_torch_model
from inat_vision_saliency.onnx_convert import ensure_onnx
from inat_vision_saliency.preprocess import preprocess_image_bytes, preprocess_image_path, preprocess_pil_rgb
from inat_vision_saliency.saliency_map import (
    compute_input_grad_saliency,
    compose_saliency_output,
    minimal_square_bbox_xyxy,
    save_visualization,
)


@dataclass(frozen=True)
class SaliencyResult:
    """Output of a single saliency run (library-friendly for RN bridge or services)."""

    saliency_magnitude: np.ndarray
    """Shape (299, 299), float64/float32; |∂p_c/∂I| aggregated over RGB channels."""

    class_index: int
    """Model leaf index (matches taxonomy `leaf_class_id`)."""

    top_probability: float
    """Softmax probability p_c for `class_index`."""

    probabilities: np.ndarray
    """Shape (num_classes,), float32 softmax vector."""

    rgb_input_u8: np.ndarray
    """Shape (299, 299, 3) uint8; the resized RGB input shown to the model."""

    bbox_square_xyxy: tuple[int, int, int, int] | None
    """Inclusive (x0, y0, x1, y1) smallest square covering high-saliency pixels; None if unknown."""


def prepare_model(
    *,
    tflite_path: Path | None,
    download_model: bool,
    onnx_cache: Path,
    force_reconvert: bool,
) -> tuple[Path, torch.nn.Module]:
    """Ensure TFLite + ONNX exist; return (tflite_path, torch_model)."""
    tflite = ensure_tflite(tflite_path, download=download_model)
    ensure_onnx(tflite, onnx_cache, force_reconvert=force_reconvert)
    model = load_torch_model(onnx_cache)
    return tflite, model


def run_saliency_on_tensor(
    model: torch.nn.Module,
    x: torch.Tensor,
    rgb_u8: np.ndarray,
    *,
    class_index: int | None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> SaliencyResult:
    mag, cls, probs_t = compute_input_grad_saliency(model, x, class_index=class_index)
    probs = probs_t.cpu().numpy().astype(np.float32)[0]
    top_p = float(probs[cls])
    h, w = mag.shape
    bbox = minimal_square_bbox_xyxy(
        mag,
        height=h,
        width=w,
        quantile=bbox_quantile,
        min_peak_frac=bbox_min_peak_frac,
    )
    return SaliencyResult(
        saliency_magnitude=mag,
        class_index=cls,
        top_probability=top_p,
        probabilities=probs,
        rgb_input_u8=rgb_u8,
        bbox_square_xyxy=bbox,
    )


def run_saliency_on_image_path(
    model: torch.nn.Module,
    image_path: Path,
    *,
    class_index: int | None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_image_path(image_path)
    return run_saliency_on_tensor(
        model,
        x,
        rgb_u8,
        class_index=class_index,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )


def run_saliency_on_image_bytes(
    model: torch.nn.Module,
    data: bytes,
    *,
    class_index: int | None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_image_bytes(data)
    return run_saliency_on_tensor(
        model,
        x,
        rgb_u8,
        class_index=class_index,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )


def run_saliency_pil(
    model: torch.nn.Module,
    image: Image.Image,
    *,
    class_index: int | None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_pil_rgb(image)
    return run_saliency_on_tensor(
        model,
        x,
        rgb_u8,
        class_index=class_index,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )


def render_overlay_png(
    result: SaliencyResult,
    *,
    overlay_alpha: float,
    draw_bounding_square: bool = True,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> bytes:
    """Encode saliency overlay as PNG bytes (e.g. for HTTP responses or tests)."""
    blend_u8 = compose_saliency_output(
        result.rgb_input_u8,
        result.saliency_magnitude,
        overlay_alpha=overlay_alpha,
        draw_bounding_square=draw_bounding_square,
        bbox_xyxy=result.bbox_square_xyxy,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )
    buf = BytesIO()
    Image.fromarray(blend_u8).save(buf, format="PNG")
    return buf.getvalue()


def run_file_to_png(
    *,
    image_path: Path,
    output_path: Path,
    tflite_path: Path | None,
    download_model: bool,
    onnx_cache: Path,
    class_index: int | None,
    overlay_alpha: float,
    force_reconvert: bool,
    draw_bounding_square: bool = True,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> SaliencyResult:
    """End-to-end: artifacts + inference + write overlay PNG (CLI uses this)."""
    _, model = prepare_model(
        tflite_path=tflite_path,
        download_model=download_model,
        onnx_cache=onnx_cache,
        force_reconvert=force_reconvert,
    )
    result = run_saliency_on_image_path(
        model,
        image_path,
        class_index=class_index,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )
    save_visualization(
        result.rgb_input_u8,
        result.saliency_magnitude,
        output_path,
        overlay_alpha=overlay_alpha,
        draw_bounding_square=draw_bounding_square,
        bbox_xyxy=result.bbox_square_xyxy,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )
    return result
