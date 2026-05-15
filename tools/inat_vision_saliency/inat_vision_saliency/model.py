"""Load the differentiable ONNX graph as a PyTorch module."""

from __future__ import annotations

from pathlib import Path

import onnx
import torch
from onnx2torch import convert


def load_torch_model(onnx_path: Path) -> torch.nn.Module:
    model = convert(onnx.load(str(onnx_path)))
    model.eval()
    return model
