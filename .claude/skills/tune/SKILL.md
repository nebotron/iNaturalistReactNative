---
name: tune
description: Improve performance of the CV-based subject detector.
---

Improve the iNaturalist subject detection score on the labeled image set (crop_training.json, typically 300–400 images).
Report the baseline score, try to beat it, and if you do, apply the change. Commit everything, including the model file.

## Scoring

All evaluation uses the weighted metric:  **score = (2×recall + 1×precision) / 3**, range 0–1, higher is better.

The evaluation helper is `scripts/evaluate_subject_detector.py`, but the correct tool for evaluating the
**actual deployed model** is `scripts/eval_onnx_variants.py`, which runs the real ONNX inference pipeline
against multiple models and post-processing algorithms in one shot.

## Step-by-step process

### 1. Populate the image cache (first run only)

Run `eval_onnx_variants.py` to download images and get the baseline:

```
python3 scripts/eval_onnx_variants.py crop_training.json > /tmp/eval_base.log 2>&1
```

Images download to `/tmp/inat_eval_cache/`. About 74 entries in crop_training.json resolve to
`static.inaturalist.org` URLs that are network-blocked in this environment (host_not_allowed);
they fall back to the S3 mirror and typically 404. This is expected — roughly 328/402 images
resolve successfully and that is the working set.

### 2. Tune inference thresholds (fast — try this first)

```
python3 scripts/tune_thresholds.py crop_training.json
```

This grid-searches gate_conf, union_thresh, top_k, and padding without any retraining (~2 min).
If it finds an improvement, update the three constants in `ios/iNaturalistReactNative/ImageCropper.m`
and padding in `src/sharedHelpers/subjectDetectionModels.ts`.

### 3. Retrain the model (slower — try if thresholds already optimal)

Use `scripts/retrain_from_cache.py`. **Critical constraints:**

- **Do NOT use `yolov8s-worldv2.pt` as base** — it requires CLIP text-encoder weights from
  `openaipublic.azureedge.net`, which is network-blocked. Training will fail mid-setup.
- Use `--base yolov8s.pt` (locally present, no external downloads needed) or `--base yolov8n.pt`.
- The script calls `trained.set_classes(["subject"])` after training, which only exists on YOLO-World
  models. If using a plain YOLOv8 base, skip that call (or guard with `if hasattr(trained, "set_classes")`).
- **Don't overwrite the deployed model until you've confirmed improvement.** Edit the retrain script
  (or a copy) to save the export to `/tmp/inat_candidate_model.onnx` instead of directly into
  `ios/iNaturalistReactNative/yolov8n.onnx`.

CPU training pace: ~3–5 min/epoch with 278 train images and imgsz=640 on a 4-core machine.
50 epochs takes ~2.5 hours; use `--patience 15` for early stopping.

### 4. Evaluate the candidate model

Add the candidate model path to `MODELS` in `eval_onnx_variants.py` (or a temp copy), then run:

```
python3 scripts/eval_onnx_variants.py crop_training.json
```

Compare the winner's score against the baseline (yolov8n_current / union). Only proceed if improved.

### 5. Install if better

If the new model scores higher:

1. Copy the `.onnx` file to `ios/iNaturalistReactNative/yolov8n.onnx`
2. Update padding in `src/sharedHelpers/subjectDetectionModels.ts`
3. Update constants in `ios/iNaturalistReactNative/ImageCropper.m` if thresholds changed

### 6. Commit

Commit the ONNX model, the TypeScript padding file, ImageCropper.m, and crop_training.json if updated.
The model is large (~12 MB) but must be committed — it's the deployed artifact.

## Key files

| File | Purpose |
|------|---------|
| `ios/iNaturalistReactNative/yolov8n.onnx` | Deployed model (single-class fine-tuned YOLOv8, INT8) |
| `ios/iNaturalistReactNative/ImageCropper.m` | ObjC inference: YOLO_GATE_CONF, YOLO_UNION_THRESH, YOLO_UNION_MAX_K |
| `src/sharedHelpers/subjectDetectionModels.ts` | SUBJECT_DETECTION_MODEL_PADDING |
| `crop_training.json` | Labeled crop dataset (list of {url, x, y, w, h}) |
| `scripts/eval_onnx_variants.py` | Baseline evaluation across models and algorithms |
| `scripts/tune_thresholds.py` | Grid search over inference thresholds (no retraining) |
| `scripts/retrain_from_cache.py` | Fine-tune from cached images; defaults to yolov8s-worldv2 (avoid — use yolov8s.pt) |

## Current baseline (as of 2026-06-16)

- **Model**: `yolov8n.onnx` (fine-tuned single-class, 50 epochs from yolov8s-worldv2 base)
- **Algorithm**: union, gate=0.25, union_thresh=0.60, top_k=3
- **Padding**: 0.03
- **Score**: 0.919 (recall=0.967, precision=0.825) on 328 images
