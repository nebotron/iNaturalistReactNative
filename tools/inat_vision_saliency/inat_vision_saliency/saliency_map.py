"""Gradient saliency, colormap, overlay export, and salient-region square bbox."""

from __future__ import annotations

from pathlib import Path

from matplotlib import colormaps
import numpy as np
import torch
from PIL import Image, ImageDraw


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


def minimal_square_bbox_xyxy(
    mag: np.ndarray,
    *,
    height: int,
    width: int,
    quantile: float = 93.0,
    min_peak_frac: float = 0.18,
) -> tuple[int, int, int, int] | None:
    """
    Smallest axis-aligned square that contains all pixels with saliency >= threshold.

    Threshold is max(peak * min_peak_frac, percentile(mag, quantile)). Returns inclusive
    pixel coordinates (x0, y0, x1, y1) clipped to the image, or None if no salient pixels.
    """
    if mag.shape != (height, width):
        raise ValueError(f"Expected mag shape ({height}, {width}), got {mag.shape}")
    m = mag.astype(np.float64)
    peak = float(m.max()) * min_peak_frac
    thr = max(peak, float(np.percentile(m, quantile)))
    mask = m >= thr
    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        thr = float(np.percentile(m, 85.0))
        ys, xs = np.nonzero(m >= thr)
    if ys.size == 0:
        return None

    ymin, ymax = int(ys.min()), int(ys.max())
    xmin, xmax = int(xs.min()), int(xs.max())
    w = xmax - xmin + 1
    h = ymax - ymin + 1
    side = max(w, h)
    if side > min(height, width):
        side = min(height, width)

    cx = 0.5 * (xmin + xmax)
    cy = 0.5 * (ymin + ymax)
    x0 = int(np.floor(cx - (side - 1) / 2.0))
    y0 = int(np.floor(cy - (side - 1) / 2.0))
    x0 = max(0, min(x0, width - side))
    y0 = max(0, min(y0, height - side))
    x1 = x0 + side - 1
    y1 = y0 + side - 1
    return (x0, y0, x1, y1)


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


def draw_square_xyxy_on_u8(
    image_hw3: np.ndarray,
    bbox: tuple[int, int, int, int],
    *,
    outline: tuple[int, int, int] = (0, 255, 90),
    width: int = 3,
) -> np.ndarray:
    """Return a copy with a square outline (PIL uses exclusive right/bottom)."""
    out = image_hw3.copy()
    im = Image.fromarray(out)
    draw = ImageDraw.Draw(im)
    x0, y0, x1, y1 = bbox
    draw.rectangle([x0, y0, x1 + 1, y1 + 1], outline=outline, width=width)
    return np.asarray(im, dtype=np.uint8)


def compose_saliency_output(
    rgb_u8: np.ndarray,
    mag: np.ndarray,
    *,
    overlay_alpha: float,
    draw_bounding_square: bool,
    bbox_xyxy: tuple[int, int, int, int] | None = None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> np.ndarray:
    blended = blend_overlay(rgb_u8, mag, overlay_alpha=overlay_alpha)
    if not draw_bounding_square:
        return blended
    h, w = mag.shape
    bbox = bbox_xyxy
    if bbox is None:
        bbox = minimal_square_bbox_xyxy(
            mag,
            height=h,
            width=w,
            quantile=bbox_quantile,
            min_peak_frac=bbox_min_peak_frac,
        )
    if bbox is None:
        return blended
    return draw_square_xyxy_on_u8(blended, bbox)


def save_visualization(
    rgb_u8: np.ndarray,
    mag: np.ndarray,
    out_path: Path,
    *,
    overlay_alpha: float,
    draw_bounding_square: bool = True,
    bbox_xyxy: tuple[int, int, int, int] | None = None,
    bbox_quantile: float = 93.0,
    bbox_min_peak_frac: float = 0.18,
) -> None:
    blend_u8 = compose_saliency_output(
        rgb_u8,
        mag,
        overlay_alpha=overlay_alpha,
        draw_bounding_square=draw_bounding_square,
        bbox_xyxy=bbox_xyxy,
        bbox_quantile=bbox_quantile,
        bbox_min_peak_frac=bbox_min_peak_frac,
    )
    Image.fromarray(blend_u8).save(out_path)
