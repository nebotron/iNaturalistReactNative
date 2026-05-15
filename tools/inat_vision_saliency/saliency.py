#!/usr/bin/env python3
"""
Gradient saliency for the iNaturalist mobile vision model (v25.01.15 release).

The published artifact is a quantized TFLite model; autograd is applied to a dequantized ONNX
export produced by tf2onnx (see convert_tflite_to_onnx.py). Numerical outputs differ slightly
from TFLite (~1e-3 on class probabilities) but gradients are well-defined for visualization.

Input preprocessing matches vision-camera-plugin-inatvision ImageClassifier for current models:
299x299, float32 RGB in [0, 255] (not normalized to [0, 1]).
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from matplotlib import colormaps
import numpy as np
import onnx
import torch
from onnx2torch import convert
from PIL import Image


DEFAULT_MODEL_URL = (
    "https://github.com/inaturalist/model-files/releases/download/v25.01.15/"
    "INatVision_Small_2_fact256_8bit.tflite"
)

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPT_DIR / ".cache"
DEFAULT_ONNX = DEFAULT_CACHE / "inat_vision_dequant.onnx"
DEFAULT_TFLITE = DEFAULT_CACHE / "INatVision_Small_2_fact256_8bit.tflite"
CONVERT_SCRIPT = SCRIPT_DIR / "convert_tflite_to_onnx.py"


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    try:
        import urllib.request

        print(f"Downloading {url} -> {dest}", flush=True)
        urllib.request.urlretrieve(url, dest)
    except Exception:
        subprocess.check_call(["curl", "-fsSL", "-o", str(dest), url])


def ensure_tflite(path: Path | None, download: bool) -> Path:
    if path is not None:
        if not path.is_file():
            raise FileNotFoundError(f"TFLite model not found: {path}")
        return path
    if download:
        _download(DEFAULT_MODEL_URL, DEFAULT_TFLITE)
        return DEFAULT_TFLITE
    raise ValueError("Provide --tflite or pass --download-model.")


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


def load_torch_model(onnx_path: Path) -> torch.nn.Module:
    model = convert(onnx.load(str(onnx_path)))
    model.eval()
    return model


def preprocess_image(path: Path) -> tuple[torch.Tensor, np.ndarray]:
    """Returns (input_BHWC for model, original RGB uint8 HxWx3 at 299 for overlay)."""
    img = Image.open(path).convert("RGB")
    resized = img.resize((299, 299), Image.Resampling.BILINEAR)
    arr_u8 = np.asarray(resized, dtype=np.uint8)
    x = torch.from_numpy(arr_u8.astype(np.float32)).unsqueeze(0)
    x.requires_grad_(True)
    return x, arr_u8


def compute_input_grad_saliency(
    model: torch.nn.Module,
    x: torch.Tensor,
    *,
    class_index: int | None,
) -> tuple[np.ndarray, int, torch.Tensor]:
    """
    Vanilla gradient saliency: for predicted class c, compute ∂(y_c)/∂I with y the softmax vector.
    Returns (abs_grad_mean_over_channels HxW, class_index, detached probs).
    """
    probs = model(x)
    if class_index is None:
        class_index = int(torch.argmax(probs, dim=1).item())
    target = probs[0, class_index].sum()
    target.backward()
    g = x.grad.detach()[0]
    mag = g.abs().mean(dim=-1).cpu().numpy()
    return mag, class_index, probs.detach()


def colorize_saliency(mag: np.ndarray, cmap_name: str = "turbo") -> np.ndarray:
    mag = mag.astype(np.float64)
    mmin, mmax = mag.min(), mag.max()
    if mmax > mmin:
        norm = (mag - mmin) / (mmax - mmin)
    else:
        norm = np.zeros_like(mag)
    cmap = colormaps[cmap_name]
    rgba = cmap(norm)
    return (rgba[..., :3] * 255.0).astype(np.uint8)


def save_visualization(
    rgb_u8: np.ndarray,
    mag: np.ndarray,
    out_path: Path,
    *,
    overlay_alpha: float,
) -> None:
    heat = colorize_saliency(mag)
    base = rgb_u8.astype(np.float32) / 255.0
    over = heat.astype(np.float32) / 255.0
    blend = (1.0 - overlay_alpha) * base + overlay_alpha * over
    blend_u8 = (np.clip(blend, 0.0, 1.0) * 255.0).astype(np.uint8)
    Image.fromarray(blend_u8).save(out_path)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
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
    return p.parse_args()


def main() -> None:
    args = parse_args()
    if not args.image.is_file():
        raise FileNotFoundError(args.image)

    tflite = ensure_tflite(args.tflite, args.download_model)
    ensure_onnx(tflite, args.onnx_cache, force_reconvert=args.force_reconvert)

    model = load_torch_model(args.onnx_cache)
    x, rgb_u8 = preprocess_image(args.image)
    mag, cls, probs = compute_input_grad_saliency(model, x, class_index=args.class_index)
    score = float(probs[0, cls].item())
    print(f"target_class={cls} p={score:.6f}", flush=True)

    out = args.output
    if out is None:
        out = args.image.with_name(f"{args.image.stem}_saliency.png")

    save_visualization(rgb_u8, mag, out, overlay_alpha=args.overlay_alpha)
    print(f"Wrote {out}", flush=True)


if __name__ == "__main__":
    main()
