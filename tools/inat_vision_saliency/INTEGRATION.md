# Vision saliency: standalone tool and React Native integration

This directory contains the **`inat_vision_saliency` Python package** (importable library + CLI) used to build gradient saliency maps for the same vision weights the mobile app loads from [model-files](https://github.com/inaturalist/model-files).

## Standalone usage

### From the app repo (recommended for contributors)

```bash
pip install -e tools/inat_vision_saliency
# or: pip install -r tools/inat_vision_saliency/requirements.txt
npm run vision-saliency -- path/to/photo.jpg --download-model
```

Equivalent without npm:

```bash
cd tools/inat_vision_saliency && PYTHONPATH=. python -m inat_vision_saliency -- path/to/photo.jpg --download-model
```

After `pip install -e …`, the console script `inat-vision-saliency` is also available.

### Library API (Python services, notebooks, tests)

```python
from pathlib import Path
from inat_vision_saliency import prepare_model, run_saliency_on_image_path
from inat_vision_saliency.constants import DEFAULT_ONNX, DEFAULT_TFLITE

_, model = prepare_model(
    tflite_path=Path(DEFAULT_TFLITE),
    download_model=False,
    onnx_cache=Path(DEFAULT_ONNX),
    force_reconvert=False,
)
result = run_saliency_on_image_path(model, Path("photo.jpg"), class_index=None)
# result.saliency_magnitude, result.probabilities, result.rgb_input_u8,
# result.bbox_square_xyxy (inclusive square over high-saliency pixels), …
```

Use `render_overlay_png(result, overlay_alpha=0.45)` to get PNG bytes without writing a temp file.

### Bounding square on the output

The PNG overlay includes a **lime** outline of the **smallest axis-aligned square** that contains pixels whose saliency magnitude is at least `max(peak * bbox_min_peak_frac, percentile(mag, bbox_quantile))` (defaults: 0.18 and 93). The same `(x0, y0, x1, y1)` inclusive coordinates are exposed as `SaliencyResult.bbox_square_xyxy` and mirrored in TypeScript `VisionSaliencyResult.bboxSquareXyxy`. CLI flags: `--no-bbox`, `--bbox-quantile`, `--bbox-min-peak-frac`.

## GitHub Pages (browser demo)

Static files live under **`docs/inat-saliency-web/`** in this repository. The page loads **TensorFlow.js** from a CDN, **`tfjs_model/`** (graph weights exported from the dequantized ONNX for the official **v25.01.15** `INatVision_Small_2_fact256_8bit.tflite`), and computes saliency with **`tf.grad`** on the predicted **softmax probability** (same objective as the Python `inat_vision_saliency` package). Preprocessing is **299×299 RGB 0–255**; a **default bear** JPEG is included so users only need to upload a photo if they want to replace it. The demo **forces the TF.js CPU backend** during saliency: WebGL can return wrong conv channel depths on the backward pass for this graph (symptom: errors like “depth of input (128) must match input depth for filter 1”).

Regenerate **`tfjs_model/`** after rebuilding the ONNX (e.g. first `npm run vision-saliency` run with `--download-model`):

```bash
bash tools/inat_vision_saliency/scripts/export_tfjs_graph_model.sh
```

To publish: enable **GitHub Pages** (for example **GitHub Actions** with **Deploy iNat saliency web to GitHub Pages**, or publish the `docs/inat-saliency-web` folder as the site root).

The converter’s TensorFlow **SavedModel** uses input shape **`[batch, 299, 3, 299]`** (transpose of NHWC); the web app applies the same transpose automatically.

## React Native integration (roadmap)

The production app runs **TFLite / Core ML** via `vision-camera-plugin-inatvision`. Those runtimes do not expose full-network autograd for this quantized model, so **on-device saliency** needs a deliberate second path.

Suggested phases:

1. **Contract in TypeScript** (done in-repo): `src/sharedHelpers/visionSaliency.ts` defines `VisionSaliencyResult` and `VISION_SALIENCY_SPEC_VERSION`. Any future producer (native module, JSI, or HTTP client) should return data matching this shape so UI code can be written once.

2. **Dev / internal builds — call Python**  
   Use `npm run vision-saliency` from scripts, Detox helpers, or a small local HTTP wrapper that imports `inat_vision_saliency.pipeline`. This keeps parity with research tooling and avoids shipping PyTorch in the app.

3. **On-device (future)**  
   - **Option A:** Ship a **float ONNX** (or TorchScript) derivative used *only* for saliency, loaded in a thin native module (ONNX Runtime Mobile / ExecuTorch / PyTorch Mobile). Size and build pipeline trade-offs need product sign-off.  
   - **Option B:** **Server-side** saliency for “Explain this ID” behind auth; the app sends a downscaled JPEG and receives a heatmap PNG or tensor summary.

4. **UI wiring**  
   When a native or network implementation exists, add a Turbo module or reuse an existing vision bridge pattern (see `vision-camera-plugin-inatvision`) that resolves a `file://` image URI, returns buffers or base64, and maps into `VisionSaliencyResult`.

## Layout

| Path | Purpose |
|------|---------|
| `inat_vision_saliency/` | Python package (`pipeline`, `cli`, …). |
| `saliency.py` | Legacy shim: `python saliency.py` with `PYTHONPATH` injection. |
| `convert_tflite_to_onnx.py` | Subprocess entry for TensorFlow / `tf2onnx` (avoid importing TF next to PyTorch). |
| `pyproject.toml` | Package metadata + `inat-vision-saliency` console script. |
| `scripts/` | `export_tfjs_graph_model.sh` — rebuild `docs/inat-saliency-web/tfjs_model/` from cached ONNX. |
| `examples/` | Gallery generator and sample assets. |
| `docs/inat-saliency-web/` (repo root) | Static GitHub Pages demo: TensorFlow.js + `tf.grad`, ships `tfjs_model/` + default bear (see **GitHub Pages** above). |

## Notes

- ONNX export is **dequantized**; probabilities can differ slightly from TFLite (~1e⁻³). Saliency is for **interpretability**, not forensic parity with the exact Lite kernels.
- Do **not** import `tensorflow` in the same Python process as `torch` for this workflow; the converter script already isolates TensorFlow.
