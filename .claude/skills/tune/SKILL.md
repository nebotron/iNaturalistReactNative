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
- Dataset: the Firebase crop log, fetched by `scripts/pull_crop_log.py` into `crop_training.json` (gitignored; regenerable).
- **Deps required:** `pip install numpy onnxruntime pillow opencv-python-headless` (and `ultralytics torch` to retrain). `evaluate_subject_detector.py` (imported by the eval script) was deleted in a past "Update skills" commit — restore it from git history if missing.
- **Eval gotcha:** if `cv2` (opencv) is NOT installed, the spectral-saliency fallback returns `None`, so every gated image (~25%) is *silently dropped* from the eval → inflated subset score. Always install opencv.
- **Image fetch (this env):** `static.inaturalist.org` and `firebaseio.com` are blocked by egress policy; the S3 mirror `inaturalist-open-data.s3.amazonaws.com` works. Originals rate-limit under high concurrency — use ≤8 workers, retries, and fall back to `medium`/`large` size (normalized boxes are size-independent since YOLO runs at 640).
