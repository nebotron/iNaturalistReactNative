---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/eval_onnx_variants.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune sessions

### Setup

- Model: `ios/iNaturalistReactNative/yolov8n.onnx` — single-class YOLOv8n, output `[1, 5, 8400]`
- Post-processing: NMS (IoU=0.45, conf=0.05) → gate (0.25 → saliency fallback) → union top-K boxes → pad → square crop
- Eval: `python3 scripts/eval_onnx_variants.py crop_training.json`
- Dataset: the Firebase crop log, fetched by `scripts/pull_logs.py` into `crop_training.json` (gitignored; regenerable).
- **Deps required:** `pip install numpy onnxruntime pillow opencv-python-headless` (and `ultralytics torch` to retrain).
- **Eval gotcha:** if `cv2` (opencv) is NOT installed, the spectral-saliency fallback returns `None`, so every gated image (~25%) is *silently dropped* from the eval → inflated subset score. Always install opencv.
- **Image fetch (this env):** `static.inaturalist.org` and `firebaseio.com` are blocked by egress policy; the S3 mirror `inaturalist-open-data.s3.amazonaws.com` works. Originals rate-limit under high concurrency — use ≤8 workers, retries, and fall back to `medium`/`large` size (normalized boxes are size-independent since YOLO runs at 640).
- The crop log has grown a lot between sessions (300 → 3357 evaluable images this time; 5613 total, ~60% resolvable — the rest 403/404 on both hosts). Use `scripts/prefetch_images.py crop_training.json` to warm `/tmp/inat_eval_cache` concurrently *before* running eval scripts — they resolve images one at a time otherwise, which is unusably slow at this scale. Build a filtered json of only cached entries (match cache filenames by photo id) so eval doesn't re-attempt the ~40% that are permanently unresolvable.
- **Background training jobs get killed by the harness after ~30 min.** For anything longer (e.g. YOLO fine-tuning), launch detached instead of via the tracked background-bash mechanism: `python3 -c '...' > log 2>&1 & disown`, then poll `ps aux` / tail the log yourself — no completion notification will arrive for it.

### Session: retraining did not beat the deployed detector

- **Brightness — removed.** The auto-brightness feature (model brightness head, `useAutoBrightnessForUri`, native luminance measurement) has since been deleted from the app; earlier notes on tuning it no longer apply.
- **Subject detection — no change adopted.** Ran the full padding × algorithm grid (`eval_onnx_variants.py`) on 3357 images: deployed config (union, pad=0.00) already wins at **score=0.866** (recall 0.947, precision 0.542); `top1`/`smallest`/`sal_isect` and every nonzero padding all scored lower. Nothing to gain from post-processing changes alone.
- **Retraining attempt failed to beat the deployed model — not because the idea is bad, but because of compute budget.** `retrain_from_cache.py` fine-tunes from *stock* `yolov8n.pt` (COCO-pretrained), not from the already-specialized deployed weights — the previous session's fine-tuned `.pt` checkpoint no longer exists locally, only its `.onnx` export (which ultralytics can't resume training from). Trained on the larger 3357-image set for 30 epochs (~2 hours wall time, repeatedly interrupted by the harness's background-job timeout, resumed as a detached process) before stopping to check: held-out eval (`eval_heldout_val.py`, forced-union, no saliency fallback, 504 never-seen images) scored **0.831 vs the deployed model's 0.878** (recall 0.906 vs 0.953, and only 386/504 vs 461/504 detections clearing the confidence gate). 30 epochs from a generic COCO checkpoint isn't enough to match a model that had substantially more fine-tuning in earlier sessions. **If retraining again: either resume from a preserved `.pt` checkpoint (save one this time — `/tmp/inat_train_local/run/weights/best.pt` before it gets cleaned up), or budget for many more epochs from scratch, and run it detached from the start.**
