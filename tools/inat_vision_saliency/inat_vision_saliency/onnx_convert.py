"""TFLite → dequantized ONNX (TensorFlow runs in a subprocess via convert script)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from inat_vision_saliency.constants import CONVERT_SCRIPT


def ensure_onnx(
    tflite: Path,
    onnx_out: Path,
    *,
    force_reconvert: bool,
) -> None:
    onnx_out.parent.mkdir(parents=True, exist_ok=True)
    if onnx_out.is_file() and not force_reconvert:
        return
    print("Converting TFLite to ONNX (TensorFlow subprocess)...", flush=True)
    subprocess.check_call(
        [
            sys.executable,
            str(CONVERT_SCRIPT),
            "--tflite",
            str(tflite),
            "--output",
            str(onnx_out),
        ],
    )
