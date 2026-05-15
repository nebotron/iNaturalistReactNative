#!/usr/bin/env python3
"""Convert the iNaturalist vision TFLite model to dequantized ONNX for differentiable inference.

Run this script alone (it imports TensorFlow). The saliency CLI loads only PyTorch and must not
import TensorFlow in the same interpreter, or some environments segfault when both are linked.
"""

from __future__ import annotations

import argparse
import subprocess
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--tflite",
        required=True,
        help="Path to INatVision_Small_2_fact256_8bit.tflite (or compatible export).",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Where to write the ONNX file (e.g. .cache/inat_vision_dequant.onnx).",
    )
    parser.add_argument(
        "--opset",
        type=int,
        default=15,
        help="ONNX opset for tf2onnx (default 15).",
    )
    args = parser.parse_args()

    cmd = [
        sys.executable,
        "-m",
        "tf2onnx.convert",
        "--tflite",
        args.tflite,
        "--output",
        args.output,
        "--dequantize",
        "--opset",
        str(args.opset),
    ]
    print("Running:", " ".join(cmd), flush=True)
    subprocess.check_call(cmd)


if __name__ == "__main__":
    main()
