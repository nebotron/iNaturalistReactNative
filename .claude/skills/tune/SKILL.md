---
name: tune
description: Improve performance of the CV-based subject detector and auto-brightness algorithm.
---

Evaluate and improve two algorithms that enhance iNaturalist observation photos in the Explore tab: the subject detector (crops to the animal/plant) and the auto-brightness adjuster.

---

# Subject detector

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
- **CLIP download is blocked in the remote session** — `set_classes()` on a YOLOWorld model tries to download CLIP ViT-B/32 from OpenAI's CDN and gets 403. The model is committed to `weights/clip/ViT-B-32.pt` (gitignore has `!weights/clip/*.pt`). If it's missing (e.g. after a fresh clone), download it on a laptop with unrestricted network access (see "CLIP model" section below) and commit it.
- `ImageCropper.m` dynamically reads output tensor shape via `GetTensorTypeAndShape`, so both `[1, 5, 8400]` (single-class) and `[1, 20, 8400]` (multi-class) formats work.
- `tune_thresholds.py` was previously broken for the multi-class model (hardcoded single-class format). Fixed 2026-06-18.
- Optimal padding: **0.12** (set in `src/sharedHelpers/subjectDetectionModels.ts`).
- `crop_training.json` is not committed (gitignored). Pull it from Firebase: `python3 scripts/pull_crop_log.py` (requires `CROP_LOG_FIREBASE_URL` in `.env`).
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

`tune_thresholds.py` grid-searches YOLO_GATE_CONF / YOLO_UNION_THRESH / top-K on the deployed model without retraining:

```sh
python3 scripts/tune_thresholds.py crop_training.json
```

## Improvement approaches (roughly ordered by expected ROI)

1. **Grow the training set.** 328 usable images is a modest benchmark. Use the in-app crop labeler (Menu → Animal Crop Tool) to add labels, then re-export `crop_training.json` via `pull_crop_log.py`.

2. **Fine-tune the World model.** `retrain_from_cache.py` now defaults to `yolov8s-worldv2.pt`. Critical changes needed to make it work:
   - Use `single_cls=False` and set `names` in `data.yaml` to a subset of the 16 deployed class names (labels in `crop_training.json` don't carry class IDs, so this needs thought — one option: use the model's own class predictions as pseudo-labels)
   - Export with `opset=12` (the script currently uses 17)
   - Skip `int8=True` initially to verify quality
   - The root cause of zero detections in previous attempts is unknown; a key hypothesis is that padded square-crop labels (user selections) don't match tight YOLO bounding boxes — experiment with deflating label boxes before training

3. **Try full-precision World model.** Export `yolov8s-worldv2.pt` to ONNX FP16 with `opset=12` and no INT8. Requires a machine with unrestricted network access (CLIP download needed for `set_classes()`). May give a meaningful accuracy gain since INT8 quantization costs some precision.

4. **Alternative architectures.** YOLO-NAS or RT-DETR may give better accuracy at similar size.

## CLIP model

`set_classes()` on a YOLOWorld model requires `ViT-B-32.pt`, which ultralytics downloads from OpenAI's CDN — blocked in remote sessions (403). The file is committed to `weights/clip/ViT-B-32.pt` so remote sessions can use it.

**If `weights/clip/ViT-B-32.pt` is missing**, download it from a laptop with open internet:

```sh
# On a laptop (not the remote session)
cd /path/to/iNaturalistReactNative
pip install ultralytics
python3 -c "
from ultralytics import YOLOWorld
m = YOLOWorld('yolov8s-worldv2.pt')
m.set_classes(['animal'])  # triggers ViT-B-32.pt download into weights/clip/
"
# The file lands at weights/clip/ViT-B-32.pt (ultralytics respects settings.yaml weights_dir)
git add weights/clip/ViT-B-32.pt
git commit -m "Add CLIP ViT-B-32 weights for YOLOWorld set_classes"
git push fork main
```

After pushing, the remote session can fetch it and `set_classes()` will work without network access.

## Applying changes

After finding improvements:
1. Copy the new model to `ios/iNaturalistReactNative/yolov8n.onnx`
2. Update `SUBJECT_DETECTION_MODEL_PADDING` in `src/sharedHelpers/subjectDetectionModels.ts` to the eval-optimal padding
3. Update inference constants in `ImageCropper.m` and the matching constants at the top of `eval_onnx_variants.py`
4. If output shape changed, verify `ImageCropper.m`'s `GetTensorTypeAndShape` path handles it correctly
5. Commit and run `/dpl`

---

# Auto-brightness algorithm

## Current state (as of 2026-06-18)

**Algorithm** (`src/sharedHelpers/useAutoBrightnessForUri.ts`):
1. Subject detection runs first; brightness measurement waits for the crop.
2. The native `measureImageBrightness` in `ImageCropper.m` samples a 64×64 grid of the *crop region* and returns average perceptual luminance `L = 0.299R + 0.587G + 0.114B`.
3. Predicted multiplier: `adj = TARGET_LUMINANCE / L`. If `|adj − 1| < TOLERANCE_FACTOR`, no adjustment is applied. Result is clamped to [0.4, 3.0].
4. Manual labels saved via the in-app brightness slider (green **label** button) always override the auto-computed value.

**Current parameters:**
| Parameter | Value | Location |
|-----------|-------|----------|
| `TARGET_LUMINANCE` | 0.45 | `src/sharedHelpers/useAutoBrightnessForUri.ts:8` |
| `TOLERANCE_FACTOR` | 0.15 | `src/sharedHelpers/useAutoBrightnessForUri.ts:9` |

**Training data:** brightness labels are saved to Firebase at `CROP_LOG_FIREBASE_URL/brightness_log.json` (same project as the crop log). Use the MediaViewer brightness slider to label images: adjust until the photo looks right, then tap the green **label** icon.

## Collecting labels

Open any observation photo in full-screen (tap it from Explore). Adjust the brightness slider until the image looks correct, then tap the green **label** button. Labels sync to Firebase automatically.

Pull the current label set:
```sh
python3 scripts/pull_brightness_log.py
# writes brightness_training.json
```

## Evaluation

```sh
python3 scripts/tune_brightness.py [brightness_training.json] [crop_training.json]
```

The script:
1. Loads brightness labels from `brightness_training.json`.
2. Resolves the crop region for each image (from `crop_training.json` if available, else runs YOLO + saliency).
3. Measures crop-region luminance at 64×64 (identical to the native code).
4. Grid-searches `TARGET_LUMINANCE` × `TOLERANCE_FACTOR` to minimise mean absolute error in **stops** (log₂ scale — perceptually linear).
5. Prints the best parameters and the improvement over the current defaults.

Metric: **MAE (stops)** = mean |log₂(predicted) − log₂(labeled)|. Lower is better; 0.5 stops ≈ 41% brightness error.

## Applying changes

After `tune_brightness.py` reports better parameters, update two constants in `src/sharedHelpers/useAutoBrightnessForUri.ts`:

```typescript
const TARGET_LUMINANCE = 0.45;   // ← update to tuned value
const TOLERANCE_FACTOR = 0.15;   // ← update to tuned value
```

Commit and run `/dpl`.

## Improvement approaches

1. **Label more images.** The accuracy of the optimal parameters scales directly with dataset size. Aim for ≥100 labeled images covering a range of lighting conditions (overexposed, underexposed, well-lit, backlit).

2. **Per-taxon targets.** Some taxa (e.g. dark beetles, pale flowers) may warrant different target luminances. A future version could look up `TARGET_LUMINANCE` by iconic taxon.

3. **Luminance histogram.** Rather than measuring the mean, a percentile (e.g. p75) of the crop luminance could be more robust for high-contrast scenes where the subject is lighter than its background.

4. **Exposure-aware clamping.** The current [0.4, 3.0] clamp range is fixed. Extend the tuning grid to include `BRIGHTNESS_MIN` / `BRIGHTNESS_MAX` clamp values if extreme adjustments turn out to be common.
