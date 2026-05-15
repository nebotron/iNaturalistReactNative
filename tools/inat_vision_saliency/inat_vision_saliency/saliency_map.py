"""Gradient saliency, colormap, and overlay export."""

from __future__ import annotations

from pathlib import Path

from matplotlib import colormaps
import numpy as np
import torch
from PIL import Image


def compute_input_grad_saliency(
    model: torch.nn.Module,
    x: torch.Tensor,
    *,
    class_index: int | None,
) -> tuple[np.ndarray, int, torch.Tensor]:
    """
    Gradient of softmax class probability w.r.t. input. Returns
    (abs_grad_mean_over_channels HxW, class_index, detached probs BxC).
    """
    if x.grad is not None:
        x.grad.zero_()
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


def blend_overlay(
    rgb_u8: np.ndarray,
    mag: np.ndarray,
    *,
    overlay_alpha: float,
) -> np.ndarray:
    heat = colorize_saliency(mag)
    base = rgb_u8.astype(np.float32) / 255.0
    over = heat.astype(np.float32) / 255.0
    blend = (1.0 - overlay_alpha) * base + overlay_alpha * over
    return (np.clip(blend, 0.0, 1.0) * 255.0).astype(np.uint8)


def save_visualization(
    rgb_u8: np.ndarray,
    mag: np.ndarray,
    out_path: Path,
    *,
    overlay_alpha: float,
) -> None:
    blend_u8 = blend_overlay(rgb_u8, mag, overlay_alpha=overlay_alpha)
    Image.fromarray(blend_u8).save(out_path)
