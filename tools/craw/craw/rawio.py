"""Raw decoding and image output.

LibRaw (through rawpy) handles the C-RAW bitstream; everything downstream
works on linear float RGB so the corrections are applied in light, not in
gamma-encoded values.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
import rawpy

from .cr3 import Geometry


def decode(path: str, half_size: bool = False, auto_bright: bool = False):
    """Decode a raw file to linear float32 RGB in [0, 1] plus LibRaw's sizes."""
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(half_size=half_size, gamma=(1, 1),
                              no_auto_bright=not auto_bright, output_bps=16,
                              use_camera_wb=True)
        sizes = raw.sizes
    return rgb.astype(np.float32) / 65535.0, sizes


def optical_centre(sizes, geometry: Geometry, half_size: bool = False
                   ) -> Tuple[float, float]:
    """Optical axis in decoded-image pixel coordinates.

    LibRaw's output keeps a few pixels of margin that Canon's crop does not, so
    the centre of Canon's active area is mapped through both margins instead of
    assuming the image centre.
    """
    scale = 0.5 if half_size else 1.0
    if geometry.active_width and geometry.active_left is not None:
        cx = (geometry.active_left - sizes.left_margin
              + geometry.active_width / 2.0 - geometry.crop_left)
        cy = (geometry.active_top - sizes.top_margin
              + geometry.active_height / 2.0 - geometry.crop_top)
    else:
        cx, cy = sizes.width / 2.0, sizes.height / 2.0
    return cx * scale, cy * scale


def downsample(img: np.ndarray, factor: int) -> np.ndarray:
    """Block-mean by an integer factor (keeps channels aligned)."""
    if factor <= 1:
        return img
    h = img.shape[0] // factor * factor
    w = img.shape[1] // factor * factor
    return img[:h, :w].reshape(h // factor, factor, w // factor, factor,
                               img.shape[2]).mean(axis=(1, 3))


def _srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def write_image(path: str, img: np.ndarray, linear: bool = False,
                quality: int = 95) -> None:
    """Write .ppm (16-bit) or any PIL-supported 8-bit format."""
    out = img if linear else _srgb(img)
    out = np.clip(out, 0.0, 1.0)
    if path.lower().endswith((".ppm", ".pnm")):
        data = (out * 65535.0 + 0.5).astype(">u2")
        with open(path, "wb") as fh:
            fh.write(f"P6\n{img.shape[1]} {img.shape[0]}\n65535\n".encode())
            fh.write(data.tobytes())
        return
    from PIL import Image
    im = Image.fromarray((out * 255.0 + 0.5).astype(np.uint8))
    if path.lower().endswith((".jpg", ".jpeg")):
        im.save(path, quality=quality, subsampling=0)
    else:
        im.save(path)
