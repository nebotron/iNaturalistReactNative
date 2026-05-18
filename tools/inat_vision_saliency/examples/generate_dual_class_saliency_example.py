#!/usr/bin/env python3
"""Build a side-by-side example: true PyTorch ∂(softmax class k)/∂pixels for two leaf classes.

Uses ``inat_vision_saliency`` (same autograd path as the CLI). Each saliency map is tinted with a
single RGB color (heatmap = magnitude of the per-pixel gradient, normalized, multiplied by one color).

Default classes are **Mallard** (``Anas platyrhynchos``, leaf index 188) and **Canada Goose**
(``Branta canadensis``, leaf index 265). The v25.01.15 ``INatVision_Small_2`` head has **507** leaves;
**Gadwall** is not among them.

Default input is a **public-domain** Wikimedia Commons photo of a **male mallard with Canada geese** (USFWS; see ``DUAL_SALIENCY_EXAMPLE.md``).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image

from inat_vision_saliency.constants import DEFAULT_ONNX, DEFAULT_TFLITE
from inat_vision_saliency.pipeline import prepare_model, run_saliency_on_tensor
from inat_vision_saliency.preprocess import preprocess_pil_rgb


def _norm01(mag: np.ndarray) -> np.ndarray:
    lo, hi = float(mag.min()), float(mag.max())
    if hi <= lo + 1e-12:
        return np.zeros_like(mag, dtype=np.float64)
    return (mag.astype(np.float64) - lo) / (hi - lo)


def _mono_blend(rgb_u8: np.ndarray, mag: np.ndarray, rgb: tuple[float, float, float], alpha: float) -> np.ndarray:
    """Blend normalized magnitude map (H,W) over rgb_u8 (H,W,3) uint8 using a single RGB color (0-255)."""
    n = _norm01(mag)[..., None]
    c = np.array(rgb, dtype=np.float64).reshape(1, 1, 3) / 255.0
    base = rgb_u8.astype(np.float64) / 255.0
    heat = n * c
    out = (1.0 - alpha) * base + alpha * heat
    return (np.clip(out, 0.0, 1.0) * 255.0).astype(np.uint8)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--image",
        type=Path,
        default=None,
        help="Input JPEG/PNG (default: bundled example download URL saved under examples/inputs/).",
    )
    p.add_argument("--class-a", type=int, default=188, help="First leaf class index (default 188 Mallard).")
    p.add_argument("--class-b", type=int, default=265, help="Second leaf class index (default 265 Canada Goose).")
    p.add_argument(
        "--color-a",
        type=str,
        default="29,78,216",
        help="R,G,B for first map (default deep blue for Mallard).",
    )
    p.add_argument(
        "--color-b",
        type=str,
        default="234,88,12",
        help="R,G,B for second map (default orange for second species).",
    )
    p.add_argument("--alpha", type=float, default=0.62, help="Blend alpha for colored saliency overlays.")
    p.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "outputs",
        help="Directory for PNG + JSON metadata.",
    )
    args = p.parse_args()

    ex_dir = Path(__file__).resolve().parent
    default_img = ex_dir / "inputs" / "example_mallard_drake_with_canada_geese.jpg"
    image_path = args.image or default_img
    if not image_path.is_file():
        raise FileNotFoundError(f"Missing input image: {image_path}")

    ca = tuple(float(x) for x in args.color_a.split(","))
    cb = tuple(float(x) for x in args.color_b.split(","))
    if len(ca) != 3 or len(cb) != 3:
        raise ValueError("color-a and color-b must be 'R,G,B' with values 0-255")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    _, model = prepare_model(
        tflite_path=DEFAULT_TFLITE,
        download_model=False,
        onnx_cache=DEFAULT_ONNX,
        force_reconvert=False,
    )

    pil = Image.open(image_path).convert("RGB")
    try:
        in_rel = str(image_path.resolve().relative_to(ex_dir))
    except ValueError:
        in_rel = str(image_path.resolve())
    meta: dict = {"input_image": in_rel, "classes": []}

    panels: list[tuple[str, np.ndarray]] = []
    pil_small = pil.resize((299, 299), Image.Resampling.BILINEAR)
    rgb_u8_base = np.asarray(pil_small, dtype=np.uint8)
    panels.append(("Input (299×299)", rgb_u8_base))

    for label, cls, col in (
        ("|∂p/∂I| Mallard (leaf 188)", args.class_a, ca),
        ("|∂p/∂I| Canada Goose (leaf 265)", args.class_b, cb),
    ):
        x, rgb_u8 = preprocess_pil_rgb(pil)
        res = run_saliency_on_tensor(
            model,
            x,
            rgb_u8,
            class_index=cls,
        )
        blend = _mono_blend(res.rgb_input_u8, res.saliency_magnitude, col, args.alpha)
        panels.append((label, blend))
        meta["classes"].append(
            {
                "leaf_class_id": int(res.class_index),
                "top_probability": float(res.top_probability),
                "bbox_square_xyxy": list(res.bbox_square_xyxy) if res.bbox_square_xyxy else None,
            },
        )

    out_panel = args.out_dir / "example_waterfowl_dual_saliency_true_backprop.png"
    fig, axes = plt.subplots(1, len(panels), figsize=(4.2 * len(panels), 4.4), dpi=160)
    for ax, (title, arr) in zip(axes, panels, strict=True):
        ax.imshow(arr)
        ax.set_title(title, fontsize=10)
        ax.axis("off")
    fig.suptitle(
        "True backprop (PyTorch autograd) — v25.01.15 INatVision_Small_2 (507 leaves). "
        "Mallard (188) vs Canada Goose (265); single-color maps per class.",
        fontsize=9,
        y=1.02,
    )
    fig.tight_layout()
    fig.savefig(out_panel, bbox_inches="tight")
    plt.close(fig)

    meta_path = args.out_dir / "example_waterfowl_dual_saliency_true_backprop.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print("Wrote", out_panel)
    print("Wrote", meta_path)


if __name__ == "__main__":
    main()
