---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/eval_onnx_variants.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. In parallel, also try to improve the algorithm for automatically picking brightness based on firebase training data. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune sessions

### Setup

- Model: `ios/iNaturalistReactNative/yolov8n.onnx` — single-class YOLOv8n, output `[1, 5, 8400]`
- Post-processing: NMS (IoU=0.45, conf=0.05) → gate (0.25 → saliency fallback) → union top-K boxes → pad → square crop
- Eval: `python3 scripts/eval_onnx_variants.py crop_training.json`
- Dataset: `crop_training.json` = 605 Firebase images. Canonical; fetched from Firebase and committed as fallback.

### Session 2026-06-26: algorithm tuning (no improvement)

**Baseline: 0.918 on 328/402 images** (74 blocked at static.inaturalist.org, now resolved via S3 mirror)

Tried: algorithm variants (top1, sal_isect, smallest), 8 custom post-processing algorithms, 504-config parameter sweep, TTA (flip variants). All within ±0.001. GPU retraining not available (no CUDA; CPU 8–9 min/epoch). No changes deployed.

### Session 2026-06-27: MPS retraining

**Baseline: 0.700 on 605 Firebase images** (union+pad=0.08 optimal; deployed union+pad=0.03 ≈ same)

MPS (Apple Metal) works for training: ~25s/epoch vs 8–9 min CPU. `retrain_from_cache.py` fixed: `device="mps"`, removed `set_classes()` (YOLO World-only), export float32 ONNX.
