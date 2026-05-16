#!/usr/bin/env python3
"""HTTP helper for exact input-gradient saliency (PyTorch autograd) for the static web demo.

ONNX Runtime Web cannot run reverse-mode autograd on this graph, and exporting a single
gradient ONNX from the onnx2torch stack is not supported. This tiny server runs the same
`inat_vision_saliency` path as ``npm run vision-saliency`` so the browser can request true
∂(softmax top class)/∂pixels while you develop locally.

Example (repo root, after ``pip install -e tools/inat_vision_saliency``)::

    python3 tools/inat_vision_saliency/scripts/saliency_grad_http_server.py --port 8765

Then open the GitHub Pages demo with::

    .../index.html?gradApi=http://127.0.0.1:8765

The page POSTs a JPEG of the 299×299 canvas to ``POST /saliency`` and receives JSON with a
base64-encoded float32 saliency magnitude map (row-major, shape 299×299).
"""

from __future__ import annotations

import argparse
import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from inat_vision_saliency.constants import DEFAULT_ONNX, DEFAULT_TFLITE
from inat_vision_saliency.pipeline import prepare_model, run_saliency_on_image_bytes


_model_lock = threading.Lock()
_model: Any = None


def _get_model():
    global _model
    with _model_lock:
        if _model is None:
            _, _model = prepare_model(
                tflite_path=DEFAULT_TFLITE,
                download_model=False,
                onnx_cache=DEFAULT_ONNX,
                force_reconvert=False,
            )
        return _model


class SaliencyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[saliency-grad-server] {self.address_string()} - {fmt % args}")

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self.path != "/saliency" and self.path != "/saliency/":
            self.send_error(404)
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/saliency" and self.path != "/saliency/":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Bad Content-Length")
            return
        if length <= 0 or length > 30 * 1024 * 1024:
            self.send_error(400, "Body too large or empty")
            return
        raw = self.rfile.read(length)
        try:
            img = Image.open(BytesIO(raw)).convert("RGB").resize((299, 299), Image.Resampling.BILINEAR)
        except OSError:
            self.send_error(400, "Could not decode image body (send raw JPEG/PNG bytes)")
            return
        buf = BytesIO()
        img.save(buf, format="JPEG", quality=92)
        model = _get_model()
        result = run_saliency_on_image_bytes(
            model,
            buf.getvalue(),
            class_index=None,
        )
        mag = np.ascontiguousarray(result.saliency_magnitude.astype(np.float32))
        if mag.shape != (299, 299):
            self.send_error(500, "Unexpected saliency shape")
            return
        bbox = result.bbox_square_xyxy
        payload = {
            "class_index": int(result.class_index),
            "top_probability": float(result.top_probability),
            "bbox_square_xyxy": list(bbox) if bbox is not None else None,
            "mag_b64": base64.b64encode(mag.tobytes()).decode("ascii"),
            "mag_height": 299,
            "mag_width": 299,
        }
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default 127.0.0.1).")
    parser.add_argument("--port", type=int, default=8765, help="TCP port (default 8765).")
    args = parser.parse_args()
    httpd = ThreadingHTTPServer((args.host, args.port), SaliencyHandler)
    print(
        f"Serving exact-gradient saliency on http://{args.host}:{args.port}/saliency\n"
        f"Open the web demo with ?gradApi=http://{args.host}:{args.port}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
