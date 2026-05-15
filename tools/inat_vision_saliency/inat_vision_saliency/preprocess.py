"""Input preprocessing aligned with vision-camera-plugin-inatvision (non-1.0 models)."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

import numpy as np
import torch
from PIL import Image


def preprocess_pil_rgb(img: Image.Image) -> tuple[torch.Tensor, np.ndarray]:
    """Resize to 299×299, RGB uint8 → float [0,255], batch dim; returns (BHWC tensor, uint8 HWC)."""
    resized = img.convert("RGB").resize((299, 299), Image.Resampling.BILINEAR)
    arr_u8 = np.asarray(resized, dtype=np.uint8)
    x = torch.from_numpy(arr_u8.astype(np.float32)).unsqueeze(0)
    x.requires_grad_(True)
    return x, arr_u8


def preprocess_image_path(path: Path) -> tuple[torch.Tensor, np.ndarray]:
    return preprocess_pil_rgb(Image.open(path))


def preprocess_image_bytes(data: bytes) -> tuple[torch.Tensor, np.ndarray]:
    return preprocess_pil_rgb(Image.open(BytesIO(data)))
