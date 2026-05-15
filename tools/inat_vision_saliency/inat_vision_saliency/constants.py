"""Paths and release URLs for the vision saliency tool."""

from __future__ import annotations

from pathlib import Path

# tools/inat_vision_saliency/ (directory that contains this package and .cache/)
TOOL_ROOT: Path = Path(__file__).resolve().parents[1]

DEFAULT_MODEL_URL = (
    "https://github.com/inaturalist/model-files/releases/download/v25.01.15/"
    "INatVision_Small_2_fact256_8bit.tflite"
)

DEFAULT_CACHE = TOOL_ROOT / ".cache"
DEFAULT_ONNX = DEFAULT_CACHE / "inat_vision_dequant.onnx"
DEFAULT_TFLITE = DEFAULT_CACHE / "INatVision_Small_2_fact256_8bit.tflite"
CONVERT_SCRIPT = TOOL_ROOT / "convert_tflite_to_onnx.py"
