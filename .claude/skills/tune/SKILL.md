---
name: tune
description: Improve performance of the CV-based subject detector.
---

Evaluate and improve the subject detector that crops iNaturalist observation photos to the most relevant subject (animal, plant, mushroom, etc.).

## Current state (as of 2026-06-18)

**Deployed model:** `ios/iNaturalistReactNative/yolov8n.onnx`
- Architecture: YOLOv8s-World v2, INT8 quantized, opset 12
- Output: `[1, 20, 8400]` — 16 subject classes (animal, insect, bird, fish, reptile, amphibian, mammal, butterfly, beetle, spider, snake, lizard, frog, mushroom, flower, plant)
- Size: 12 MB

**Deployed inference settings (`ImageCropper.m`):**
- `YOLO_CONF_THRESH = 0.05` — minimum raw score to even consider a box
- `YOLO_IOU_THRESH = 0.45` — NMS overlap threshold
- `YOLO_GATE_CONF = 0.08` — below this, fall back to saliency
- `YOLO_UNION_THRESH = 0.40` — include box if ≥40% of best-box confidence
- `YOLO_UNION_MAX_K = 5` — union up to this many boxes

**Benchmark (328 images available via S3; 74 of the original 402 are permanently 404):**
| Model / settings | Score | Recall | Precision | YOLO rate |
|---|---|---|---|---|
| World INT8, gate=0.08, union=0.40, top_k=5 **(deployed)** | **0.804** | 0.896 | 0.618 | 75% |
| World INT8, gate=0.25, union=0.60, top_k=3 (previous) | 0.783 | 0.905 | 0.541 | 58% |
| yolov8n single-class finetuned (historical) | 0.722 | 0.984 | 0.197 | 0% — pure saliency |

Score = (2×recall + 1×precision) / 3. Padding = 0.12.

## Key learnings

- **Threshold tuning gave +0.020** (2026-06-18). Lowering `YOLO_GATE_CONF` from 0.25→0.08 and widening the union criteria (0.60→0.40 thresh, 3→5 boxes) replaced low-quality saliency fallbacks with moderate-confidence YOLO boxes that have better precision. Grid-search script: see below.
- **Fine-tuned single-class yolov8n models produce zero YOLO detections** on iNat photos (all crops from saliency). Root cause unclear — possibly the training labels (user square crops with padding) don't match YOLO's expected tight bounding boxes, causing diffuse low-confidence predictions.
- **CLIP download is blocked in the remote session** — `set_classes()` on a YOLOWorld model tries to download CLIP ViT-B/32 from OpenAI's CDN and gets 403. This prevents re-exporting the World model with different class names. The workaround is to use a local machine or a session with unrestricted network access.
- `ImageCropper.m` dynamically reads output tensor shape via `GetTensorTypeAndShape`, so both `[1, 5, 8400]` (single-class) and `[1, 20, 8400]` (multi-class) formats work.
- `tune_thresholds.py` was previously broken for the multi-class model (hardcoded single-class format). Fixed 2026-06-18.
- Optimal padding: **0.12** (set in `src/sharedHelpers/subjectDetectionModels.ts`).
- `crop_training.json` is not committed. Restore it with: `git show d4355a0:crop_training.json > crop_training.json`
- 328 of 402 labeled images are downloadable (S3 open-data). The 74 on `static.inaturalist.org` return 404 on both the primary host and the S3 mirror.

## Evaluation

Use `eval_onnx_variants.py` — canonical eval script, mirrors `ImageCropper.m` logic:

```sh
pip install onnxruntime pillow numpy pyyaml
python3 scripts/eval_onnx_variants.py crop_training.json
```

Images are downloaded automatically to `/tmp/inat_eval_cache` on first run (takes a few minutes). Models are declared in the `MODELS` dict at the top — add a new path there to include it.

`evaluate_subject_detector.py` is useful for comparing detection algorithms and padding values against the Vision framework baseline.

## Threshold tuning

Run a full grid search over gate × union_thresh × top_k on the current model without retraining:

```sh
python3 scripts/tune_thresholds.py crop_training.json
```

Or inline — the grid search from the 2026-06-18 session (which found the current optimum) used this pattern:

```python
gates = [0.05, 0.08, 0.10, 0.12, 0.15, 0.18, 0.20, 0.25]
union_thresholds = [0.40, 0.50, 0.60, 0.70, 0.80]
top_ks = [1, 2, 3, 5]
```

After `eval_onnx_variants.py` confirms improvement, update `ImageCropper.m` constants and the matching constants at the top of `eval_onnx_variants.py`.

## Improvement approaches (roughly ordered by expected ROI)

1. **Grow the training set.** 328 usable images is a modest benchmark. Use the in-app crop labeler (Menu → Animal Crop Tool) to add labels, then re-export `crop_training.json` via `pull_crop_log.py`.

2. **Fine-tune the World model.** `retrain_from_cache.py` now defaults to `yolov8s-worldv2.pt`. Critical changes needed to make it work:
   - Use `single_cls=False` and set `names` in `data.yaml` to a subset of the 16 deployed class names (labels in `crop_training.json` don't carry class IDs, so this needs thought — one option: use the model's own class predictions as pseudo-labels)
   - Export with `opset=12` (the script currently uses 17)
   - Skip `int8=True` initially to verify quality
   - The root cause of zero detections in previous attempts is unknown; a key hypothesis is that padded square-crop labels (user selections) don't match tight YOLO bounding boxes — experiment with deflating label boxes before training

3. **Try full-precision World model.** Export `yolov8s-worldv2.pt` to ONNX FP16 with `opset=12` and no INT8. Requires a machine with unrestricted network access (CLIP download needed for `set_classes()`). May give a meaningful accuracy gain since INT8 quantization costs some precision.

4. **Alternative architectures.** YOLO-NAS or RT-DETR may give better accuracy at similar size.

## Applying changes

After finding improvements:
1. Copy the new model to `ios/iNaturalistReactNative/yolov8n.onnx`
2. Update `SUBJECT_DETECTION_MODEL_PADDING` in `src/sharedHelpers/subjectDetectionModels.ts` to the eval-optimal padding
3. Update inference constants in `ImageCropper.m` and the matching constants at the top of `eval_onnx_variants.py`
4. If output shape changed, verify `ImageCropper.m`'s `GetTensorTypeAndShape` path handles it correctly
5. Commit and run `/dpl`
