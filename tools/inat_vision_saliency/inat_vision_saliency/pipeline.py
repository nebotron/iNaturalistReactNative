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
    blend_overlay,
    compute_input_grad_saliency,
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
) -> SaliencyResult:
    mag, cls, probs_t = compute_input_grad_saliency(model, x, class_index=class_index)
    probs = probs_t.cpu().numpy().astype(np.float32)[0]
    top_p = float(probs[cls])
    return SaliencyResult(
        saliency_magnitude=mag,
        class_index=cls,
        top_probability=top_p,
        probabilities=probs,
        rgb_input_u8=rgb_u8,
    )


def run_saliency_on_image_path(
    model: torch.nn.Module,
    image_path: Path,
    *,
    class_index: int | None,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_image_path(image_path)
    return run_saliency_on_tensor(model, x, rgb_u8, class_index=class_index)


def run_saliency_on_image_bytes(
    model: torch.nn.Module,
    data: bytes,
    *,
    class_index: int | None,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_image_bytes(data)
    return run_saliency_on_tensor(model, x, rgb_u8, class_index=class_index)


def run_saliency_pil(
    model: torch.nn.Module,
    image: Image.Image,
    *,
    class_index: int | None,
) -> SaliencyResult:
    x, rgb_u8 = preprocess_pil_rgb(image)
    return run_saliency_on_tensor(model, x, rgb_u8, class_index=class_index)


def render_overlay_png(result: SaliencyResult, *, overlay_alpha: float) -> bytes:
    """Encode saliency overlay as PNG bytes (e.g. for HTTP responses or tests)."""
    blend_u8 = blend_overlay(
        result.rgb_input_u8,
        result.saliency_magnitude,
        overlay_alpha=overlay_alpha,
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
) -> SaliencyResult:
    """End-to-end: artifacts + inference + write overlay PNG (CLI uses this)."""
    _, model = prepare_model(
        tflite_path=tflite_path,
        download_model=download_model,
        onnx_cache=onnx_cache,
        force_reconvert=force_reconvert,
    )
    result = run_saliency_on_image_path(model, image_path, class_index=class_index)
    save_visualization(
        result.rgb_input_u8,
        result.saliency_magnitude,
        output_path,
        overlay_alpha=overlay_alpha,
    )
    return result
