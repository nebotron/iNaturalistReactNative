"""Gradient saliency for the iNaturalist vision TFLite model (library + CLI)."""

from inat_vision_saliency.constants import (
    CONVERT_SCRIPT,
    DEFAULT_CACHE,
    DEFAULT_MODEL_URL,
    DEFAULT_ONNX,
    DEFAULT_TFLITE,
    TOOL_ROOT,
)
from inat_vision_saliency.pipeline import (
    SaliencyResult,
    prepare_model,
    render_overlay_png,
    run_file_to_png,
    run_saliency_on_image_bytes,
    run_saliency_on_image_path,
    run_saliency_on_tensor,
    run_saliency_pil,
)
from inat_vision_saliency.saliency_map import minimal_square_bbox_xyxy

__all__ = [
    "CONVERT_SCRIPT",
    "DEFAULT_CACHE",
    "DEFAULT_MODEL_URL",
    "DEFAULT_ONNX",
    "DEFAULT_TFLITE",
    "SaliencyResult",
    "TOOL_ROOT",
    "minimal_square_bbox_xyxy",
    "prepare_model",
    "render_overlay_png",
    "run_file_to_png",
    "run_saliency_on_image_bytes",
    "run_saliency_on_image_path",
    "run_saliency_on_tensor",
    "run_saliency_pil",
]
