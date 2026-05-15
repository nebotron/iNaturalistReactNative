"""Download the published TFLite vision model."""

from __future__ import annotations

import subprocess
from pathlib import Path

from inat_vision_saliency.constants import DEFAULT_MODEL_URL, DEFAULT_TFLITE


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        return
    try:
        import urllib.request

        print(f"Downloading {url} -> {dest}", flush=True)
        urllib.request.urlretrieve(url, dest)
    except Exception:
        subprocess.check_call(["curl", "-fsSL", "-o", str(dest), url])


def ensure_tflite(path: Path | None, *, download: bool) -> Path:
    if path is not None:
        if not path.is_file():
            raise FileNotFoundError(f"TFLite model not found: {path}")
        return path
    if download:
        download_file(DEFAULT_MODEL_URL, DEFAULT_TFLITE)
        return DEFAULT_TFLITE
    raise ValueError("Provide a tflite path or pass download=True.")
