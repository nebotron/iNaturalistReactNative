"""Command-line entry for standalone saliency runs."""

from __future__ import annotations

import argparse
from pathlib import Path

from inat_vision_saliency.constants import DEFAULT_ONNX, DEFAULT_TFLITE
from inat_vision_saliency.pipeline import run_file_to_png


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Gradient saliency for the iNaturalist mobile vision model (v25.01.15). "
            "See tools/inat_vision_saliency/INTEGRATION.md for React Native integration notes."
        ),
    )
    p.add_argument("image", type=Path, help="Input image path (JPEG/PNG/…).")
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output saliency PNG (default: <image>_saliency.png).",
    )
    p.add_argument(
        "--tflite",
        type=Path,
        default=None,
        help="Path to the vision .tflite file (default: use --download-model cache).",
    )
    p.add_argument(
        "--download-model",
        action="store_true",
        help=f"Download the v25.01.15 TFLite release to {DEFAULT_TFLITE} if missing.",
    )
    p.add_argument(
        "--onnx-cache",
        type=Path,
        default=DEFAULT_ONNX,
        help=f"Where to read/write the dequantized ONNX (default: {DEFAULT_ONNX}).",
    )
    p.add_argument(
        "--class-index",
        type=int,
        default=None,
        help="Output class index (0..num_classes-1). Default: argmax of the prediction.",
    )
    p.add_argument(
        "--overlay-alpha",
        type=float,
        default=0.45,
        help="Blend weight for the heatmap over the input image.",
    )
    p.add_argument(
        "--force-reconvert",
        action="store_true",
        help="Rebuild ONNX from TFLite even if the ONNX file exists.",
    )
    p.add_argument(
        "--no-bbox",
        action="store_true",
        help="Do not draw the salient-region square outline on the output.",
    )
    p.add_argument(
        "--bbox-quantile",
        type=float,
        default=93.0,
        help="Percentile of saliency magnitude used as floor for salient pixels (default 93).",
    )
    p.add_argument(
        "--bbox-min-peak-frac",
        type=float,
        default=0.18,
        help="Minimum saliency threshold as a fraction of the peak (default 0.18).",
    )
    return p


def main() -> None:
    args = build_parser().parse_args()
    if not args.image.is_file():
        raise FileNotFoundError(args.image)

    out = args.output
    if out is None:
        out = args.image.with_name(f"{args.image.stem}_saliency.png")

    result = run_file_to_png(
        image_path=args.image,
        output_path=out,
        tflite_path=args.tflite,
        download_model=args.download_model,
        onnx_cache=args.onnx_cache,
        class_index=args.class_index,
        overlay_alpha=args.overlay_alpha,
        force_reconvert=args.force_reconvert,
        draw_bounding_square=not args.no_bbox,
        bbox_quantile=args.bbox_quantile,
        bbox_min_peak_frac=args.bbox_min_peak_frac,
    )
    print(f"target_class={result.class_index} p={result.top_probability:.6f}", flush=True)
    bb = result.bbox_square_xyxy
    if bb is not None:
        print(f"bbox_square={bb[0]},{bb[1]},{bb[2]},{bb[3]}", flush=True)
    else:
        print("bbox_square=", flush=True)
    print(f"Wrote {out}", flush=True)
