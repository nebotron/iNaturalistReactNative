---
name: tune
description: Improve performance of the CV-based subject detector.
---

Evaluate and improve the subject detector that crops iNaturalist observation photos to the most relevant subject (animal, plant, mushroom, etc.).

## Current state (as of 2026-06-17)

**Deployed model:** `ios/iNaturalistReactNative/yolov8n.onnx`
- Architecture: YOLOv8s-World v2, INT8 quantized, opset 12
- Output: `[1, 20, 8400]` — 16 subject classes (animal, insect, bird, fish, reptile, amphibian, mammal, butterfly, beetle, spider, snake, lizard, frog, mushroom, flower, plant)
- Size: 12 MB

**Benchmark (402 labeled images from `crop_training.json`):**
| Model | Score | Recall | Precision | Detection rate |
|-------|-------|--------|-----------|----------------|
| yolov8s-worldv2 INT8 (deployed) | **0.783** | 0.910 | 0.529 | 56% (saliency fallback for 44%) |
| yolov8n single-class (finetuned variants) | 0.722 | 0.984 | 0.197 | **0%** — pure saliency fallback |

Score = (2×recall + 1×precision) / 3

**Key learnings:**
- The finetuned single-class yolov8n models (trained via `retrain_from_cache.py`) produce **zero YOLO detections** on iNat photos — all crops come from spectral-residual saliency fallback. The 0.722 score is entirely saliency.
- The World model actually fires 56% of the time. Improving detection rate and precision on the remaining 44% is the main opportunity.
- `ImageCropper.m` now dynamically reads output tensor shape via `GetTensorTypeAndShape`, so both `[1, 5, 8400]` (single-class) and `[1, 20, 8400]` (multi-class) formats are handled.
- Optimal padding for the World model: **0.12** (set in `src/sharedHelpers/subjectDetectionModels.ts`).

## Evaluation

Use `eval_onnx_variants.py` — this is the canonical eval script. It tests ONNX models directly with the same letterbox + NMS logic as `ImageCropper.m`:

```sh
python3 scripts/eval_onnx_variants.py crop_training.json
```

Models are declared in `MODELS` dict at the top of that file. Add a new model path there to include it in the comparison run.

`evaluate_subject_detector.py` is useful for comparing detection *algorithms* (union, top1, etc.) and padding values against the Vision framework baseline — run it when the algorithm strategy in `ImageCropper.m` changes.

## Improvement approaches (roughly ordered by expected ROI)

1. **Grow the training set.** The 402 labeled images are the main bottleneck. Use the in-app crop labeler (Menu → Animal Crop Tool) to add more labels, then re-export `crop_training.json`.

2. **Fine-tune the World model.** `retrain_from_cache.py` was written for single-class yolov8n but exports with `yolov8n.pt` as the base. To fine-tune the World model instead:
   - Change `--base` to point to `yolov8s-worldv2.pt` (download from ultralytics if needed)
   - Use `single_cls=False` and set `names` in `data.yaml` to a subset of the 16 deployed classes
   - Export with `opset=12` (not 17) to match the current model; skip `int8=True` initially to verify quality before quantizing

3. **Lower the GATE threshold.** `YOLO_GATE_CONF = 0.25f` in `ImageCropper.m` causes ~44% of images to fall back to saliency. Try 0.15–0.20 if precision allows. Run `eval_onnx_variants.py` after each change to verify score doesn't drop.

4. **Try the full-precision World model.** Export `yolov8s-worldv2.pt` to ONNX FP16 or FP32 and compare score — INT8 quantization costs some accuracy. If the score gain is significant and the size is acceptable, deploy it.

5. **Alternative architectures.** YOLO-NAS or RT-DETR may give better accuracy at similar size.

## Applying changes

After finding improvements:
1. Copy the new model to `ios/iNaturalistReactNative/yolov8n.onnx`
2. Update `SUBJECT_DETECTION_MODEL_PADDING` in `src/sharedHelpers/subjectDetectionModels.ts` to the eval-optimal padding
3. If output shape changed, verify `ImageCropper.m`'s `GetTensorTypeAndShape` path handles it correctly
4. Commit and run `/dpl`
