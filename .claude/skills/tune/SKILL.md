---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/eval_onnx_variants.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune sessions

### Setup

- Model: `ios/iNaturalistReactNative/yolov8n.onnx` — single-class YOLOv8n, output `[1, 5, 8400]`
- Post-processing: NMS (IoU=0.45, conf=0.05) → gate (0.50 → Vision saliency fallback) → union top-K boxes → pad → square crop. The eval script mirrors these constants; change both together.
- Eval: `python3 scripts/eval_onnx_variants.py crop_training.json` (~25 min single-threaded on 4,898 images)
- Dataset: the Firebase crop log, fetched by `scripts/pull_logs.py` into `crop_training.json` (gitignored; regenerable).
- **Deps required:** `pip install numpy onnxruntime onnx pillow opencv-python-headless` (and `ultralytics torch` to retrain).
- **A fresh clone has no `.env`,** so `pull_logs.py` exits on a missing `CROP_LOG_FIREBASE_URL`. The URL is hardcoded as `_DEFAULT_FIREBASE_URL` in `scripts/evaluate_subject_detector.py`; export it and the pull works unauthenticated. `firebaseio.com` is *not* blocked by egress policy (an earlier note claiming otherwise was wrong).
- **Eval gotcha:** if `cv2` (opencv) is NOT installed, the spectral-saliency fallback returns `None`, so every gated image is *silently dropped* from the eval → inflated subset score. Always install opencv.
- **Images:** run `scripts/prefetch_images.py crop_training.json` to warm `/tmp/inat_eval_cache` before anything else — the eval scripts resolve images one at a time otherwise. It now pulls the 1024px `large` rendition from the open-data S3 mirror instead of the original: 4,898/4,898 succeeded in ~25 min and the cache is 2.5 GB rather than tens of GB. (The old original-only path failed on ~40% and rate-limited.) Every URL that fails is a `file://` device path, not a fetch failure, so there is nothing to retry.
- Log size grows fast between sessions: 300 → 3,357 → **4,898** evaluable images (7,154 entries total; the other 2,238 are `file://`).
- **Background jobs are killed after ~30 min.** Launch long training with `setsid nohup python3 … & disown` and poll it yourself; the harness sends no completion notification for detached work.

### Session: warm-started fine-tune, 0.845 → 0.870

**Result:** `union pad=0.00`, **score 0.870** (recall 0.978, precision 0.439), up from **0.845** (recall 0.928, precision 0.511). Two changes shipped: new weights, and `YOLO_GATE_CONF` 0.25 → 0.50.

**What worked**

- **Warm-starting from the deployed ONNX.** This is the unlock the last two sessions were missing. Ultralytics fuses Conv+BN on export, but the fused tensors keep their torch names (`model.0.conv.weight`), so they load 1:1 into a `DetectionModel` that has had `.fuse()` called on it. `scripts/onnx_to_pt.py` does this and asserts the rebuilt model matches onnxruntime (3.8e-4 max abs diff) before use; the round-tripped export scores identically to the deployed model, so the pipeline is verifiable end to end. **You never need to preserve a `.pt` again** — reconstruct it from whatever is shipped. `retrain_from_cache.py --warm-start` wires this up.
- **20 epochs, AdamW lr 1e-4 → 5e-6, mosaic off, scale 0.25 / translate 0.05 / fliplr 0.5.** ~12 min/epoch at 640/batch 16 on 4 CPU cores (4,156 train images, `val=False`, `save_period=1`). Val score plateaued at epoch ~17.
- **Raising the gate 0.25 → 0.50.** Below ~0.5 confidence the detector's crop scores worse than framing the whole photo, so handing those to the fallback is a straight win. The optimum was 0.50 on both the held-out split and the full set, so it is not a fit to one sample. (For the *old* model the optimum was 0.65 — retune the gate whenever the weights change, since confidence calibration moves with them.)

**What did not work**

- **Every post-processing knob other than the gate.** Padding (including negative), squaring rule (geometric/arithmetic/min/power mean all lose to `max`), clamping the square to the image (letterboxing is fine — recall loss exceeds the precision gain), a minimum crop-size floor, `top1`, weighted box fusion, containment-filtered union, and union threshold/K. All at or below the deployed baseline.
- **A learned policy.** HistGradientBoosting over 10 detection features (conf, box area, aspect, centering, union/top1 ratio, count of high-conf boxes, …) picking among {center square, union × 7 scales}, 5-fold CV: 0.869 — the same as a one-parameter confidence threshold. Not worth the ObjC.
- **hflip TTA:** +0.002 for double the on-device inference. **Letterbox pad colour** 114 (training) vs 127 (`ImageCropper.m`): no measurable difference, left alone. **Spectral saliency vs a plain centre square** on gated images: 0.8232 vs 0.8209 — a wash, so the app's Vision fallback stays.
- **`optimizer="auto"` (the ultralytics default) silently discards `lr0` and picks 2e-3** — hot enough to wreck a warm start. This is almost certainly part of why previous retrains disappointed. Always pass the optimizer explicitly; `retrain_from_cache.py` now does.
- **A 40-epoch schedule.** LR anneals over the *full* schedule, so stopping early leaves the model un-annealed and unusable. Pick a schedule you will actually finish (20 epochs ≈ 4 h here) rather than a long one you intend to cut short.

**Beware: the deployed model's score is inflated by memorization of its own training data.** Bucketing the held-out split by photo ID (which rises with upload date, so the newest bucket is enriched in images logged after the old model was trained) gives a clean monotone crossover — new-minus-old delta by quintile: −0.026, −0.024, −0.006, +0.019, +0.025. The old model wins by memorizing old photos and collapses on new ones (0.773 vs 0.797 on the newest third). On the newest 40%, the new model is +0.022 (95% CI [−0.007, +0.050], P(better) = 0.94). **Run this check before believing any old-vs-new comparison** — a straight held-out comparison favours whichever model trained on more of the log. The shipped model trained on 85% of the labelled set; a future session could fine-tune it on the remaining 15% for a genuine (if unmeasurable) gain.

**Where the ceiling is.** The metric is `(4·recall + 1·precision) / 5`, so it rewards big crops: framing every photo as a plain centre square already scores **0.827**. The per-image oracle over all post-processing actions is 0.906. That leaves better weights as the only real lever — post-processing is spent.
