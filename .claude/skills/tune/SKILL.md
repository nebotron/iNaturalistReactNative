---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/eval_onnx_variants.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune sessions

### Setup

- Model: `ios/iNaturalistReactNative/yolov8n.onnx` — single-class YOLOv8n, output `[1, 5, 8400]`
- Post-processing: NMS (IoU=0.45, conf=0.05) → gate (0.50 → Vision saliency fallback) → union top-K boxes → pad → square crop, with the square's side raised to `SIDE_CALIBRATION_EXPONENT` = 0.92. The eval script mirrors these constants; change both together.
- **The squaring is TypeScript, not ObjC.** `ImageCropper.m` returns *bounds*; `src/sharedHelpers/subjectBoundsToNormalizedCrop.ts` turns them into the crop (padding 0, set in `detectSubjectInImage.ts`). Geometry changes belong there — cross-platform, unit-testable, and they apply to the saliency fallback too. `scripts/evaluate_subject_detector.py:bounds_to_crop` mirrors it; a 4-case node-vs-python diff keeps them honest.
- Eval: `scripts/cache_detections.py MODEL.onnx OUT.npz` (~5 min, 4 procs) then
  `scripts/sweep_crop.py OUT.npz [--full]` (seconds). Inference is the only slow
  part, so cache the raw post-NMS boxes once and every gate/union/padding
  variant after that is arithmetic. `sweep_crop` is verified to reproduce
  `eval_onnx_variants.py` exactly (to 1e-9, end to end) — use the slow script
  only to re-confirm that after changing either.
- `scripts/score_checkpoint.py WEIGHTS.pt --slice=-1000:` exports a training
  checkpoint, asserts the export still matches the weights, and scores it on the
  crop metric. `scripts/compare_models.py OLD.npz NEW.npz` bootstraps old-vs-new
  on the held-out tail.
- Dataset: the Firebase crop log, fetched by `scripts/pull_logs.py` into `crop_training.json` (gitignored; regenerable).
- **Deps required:** `pip install numpy onnxruntime onnx pillow opencv-python-headless` (and `ultralytics torch` to retrain).
- **A fresh clone has no `.env`,** but the scripts no longer need one: the database is `DEFAULT_FIREBASE_URL` in `scripts/firebase_auth.py` and reads are unauthenticated, so `pull_logs.py` and `app_log.py` just work. Set `CROP_LOG_FIREBASE_URL` only to read a different database. `firebaseio.com` is *not* blocked by egress policy (an earlier note claiming otherwise was wrong).
- **Eval gotcha:** if `cv2` (opencv) is NOT installed, the spectral-saliency fallback returns `None`, so every gated image is *silently dropped* from the eval → inflated subset score. Always install opencv.
- **Images:** run `scripts/prefetch_images.py crop_training.json` to warm `/tmp/inat_eval_cache` before anything else — the eval scripts resolve images one at a time otherwise. It now pulls the 1024px `large` rendition from the open-data S3 mirror instead of the original: 4,898/4,898 succeeded in ~25 min and the cache is 2.5 GB rather than tens of GB. (The old original-only path failed on ~40% and rate-limited.) Every URL that fails is a `file://` device path, not a fetch failure, so there is nothing to retry.
- Log size grows fast between sessions: 300 → 3,357 → 4,898 → **7,119** evaluable images (9,399 entries; 2,238 are `file://` and ~24 are junk URLs from someone probing the open database).
- **Hold out the tail of the log, not a random split.** `crop_training.json` is in Firebase push-key order, which is chronological (median photo id rises monotonically across it), so its last N entries are the only slice a previously shipped model cannot have trained on. `retrain_from_cache.py --heldout-tail N` splits there and writes the URLs to `/tmp/heldout_tail_urls.txt`; `cache_detections.py --slice=-N:` selects the same images for scoring. Verify the two sets match before believing a comparison — they did here, exactly.
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

### Session: the warm start was never working; 0.856 → 0.868 on the log, a tie on held-out

**Result.** Whole labelled log (7,119 images): **0.8558 → 0.8680**, precision 0.392 → 0.445. Held-out tail (1,000): **0.8350 → 0.8357**, 95% CI [−0.006, +0.007], P(better) 0.60 — a tie. Shipped anyway: better or equal everywhere, and on unseen photos the fallback rate drops 55.7% → 46.7% and precision goes 0.332 → 0.369. Gate stayed at 0.50, so the model file is the whole change. (With the crop calibration from the next section on top, the shipped figures are **0.8645** whole-log and **0.8402** held-out.)

**The warm start of the last two sessions was mostly a cold start.** Two independent faults, both silent, both now fixed in `onnx_to_pt.py` (which asserts against onnxruntime at every stage — that assertion is what caught them):
- **The trainer does not train the object you hand it.** It re-parses `model.yaml` into an *unfused* `DetectionModel` and copies weights by name. A fused checkpoint has no BN tensors, so **70 of 355** transferred and ultralytics carried on with a one-line warning. The fix un-fuses: fused weight into the conv, then BN reparameterized as gamma = sqrt(var+eps), beta = mean + b from per-channel statistics calibrated on 128 real images. That reproduces the fused function *exactly* in eval mode for any mean/var — correctness does not depend on the calibration, which only buys running statistics matching what training will see. Now 355/355. **Check the transfer count in the log every time; "Transferred 70/355" is the failure.**
- **The exporter's architecture stopped round-tripping.** ultralytics 8.4.123 (which exported the August model) built YOLOv8's SPPF with the unactivated `cv1` YOLO26 introduced; 8.4.157 restores SiLU for legacy YAMLs. Names and shapes still line up, so all 127 weights "load" while everything from layer 9 on computes a different function (238 max abs diff). `onnx_to_pt` now reads the activation off the ONNX graph and writes the pooling count into the checkpoint YAML so rebuilds and exports keep it.

**The whole-log score is not the score.** The deployed model scored 0.8558 on the log but **0.8324** on the 1,000 photos it had never seen — barely over the 0.827 a plain centre square gets. Every whole-log old-vs-new number is inflated by memorization; quote the held-out one. Corollary: tune the *gate* on held-out data too, since the whole log is dominated by memorized photos whose detections are more trustworthy than a new photo's (whole-log optimum 0.50, held-out optimum 0.65, and the held-out curve is flat to 0.0013 across 0.50–0.70).

**The detector is worth about 0.005.** On unseen photos: always-centre-80% 0.8304, always-saliency 0.8242, full pipeline 0.8357. The 4:1 recall weighting means "crop big" is nearly optimal, so a better detector mostly buys precision the metric then discounts by four. Judge weights by fallback rate and precision as well as score.

**Data has saturated.** 47% more training data (4,156 → 6,113) moved held-out score by +0.0007. Either the labels are too idiosyncratic to predict — plausible, since they are whatever crop a human happened to drag — or yolov8n is capacity-limited. **Before spending another 7 hours on more data, test which.** A useful probe: score a second human's crop of the same photo against the first, if the log ever carries repeats; that upper-bounds what any model can score.

**What did not work (this session).** Padding (including negative), union threshold/K, `top1`, and the fallback choice — full frame, centre square, saliency ∪ low-confidence detection — all landed within 0.002 of the deployed configuration on 7,119 images, confirming the previous session. The best post-processing change found anywhere was +0.001, noise.

### Session (same one, continued): the crop geometry was the real lever — held-out 0.8357 → 0.8402

**Read this before tuning any post-processing knob.** Every "X never helps" conclusion in the notes above was measured on the whole log, and the whole log is ~86% photos the model trained on. On those the detector's boxes are *memorized and accurate*, so anything that widens the crop looks harmful. On photos it has never seen the boxes are noisy and widening pays. The sign flips:

| β=0.92 applied to | deployed model | retrained model |
|---|---|---|
| photos it trained on | −0.0043 (n=4,898) | −0.0052 (n=6,119) |
| photos it never saw | **+0.0026** (n=2,221) | **+0.0042** (n=1,000) |

All four CIs exclude zero. **Padding does help on unseen photos** (+0.0016 at pad 0.07) — the earlier "padding never helps" was this artifact. A power law on the side beats padding (+0.0026 vs +0.0016 on the same 2,221 photos) and padding adds nothing on top, because the right correction is proportionally larger for small boxes.

**What shipped:** `side' = M·(side/M)^0.92` where M is the image's longer edge, in `subjectBoundsToNormalizedCrop.ts`. Cross-validated *strictly inside* the held-out photos it picks 0.92 in all 5 folds for both models — a property of the task, not a fit. Worth **6× the entire retrain** and it is one line.

**How to tune post-processing from now on.** Fit and evaluate only on photos the current weights never trained on (`--slice=-1000:`, or for the previously deployed weights everything past the old log's end — a much larger pool, and the deployed model is a free second replicate). Use k-fold CV *inside* that slice; never tune on the whole log. Richer parameterizations lose: 1 parameter (β) scored +0.0042 CV, 3 params +0.0040, 5 params (confidence-dependent size and centring) +0.0040, a 7-param grid over gate+detection+fallback +0.0014. The surface is flat and the data are 1,000 photos — prefer the fewest parameters that capture the effect.

**Also checked, no action needed.** The eval's letterbox branch centres on the subject while the shipping TS centres on the image; despite affecting 37% of crops this is worth 0.0002, so the evaluator is trustworthy as-is. Re-tuning the gate after the calibration leaves 0.50 optimal (0.45/0.50/0.55 within 0.0001 on held-out). Label noise could not be measured — only 6 URLs in the raw Firebase log were ever cropped twice, so the "is this label noise or capacity?" question is still open.

**Costs, for planning.** 4 CPU cores: prefetch 7.1k images ~25 min; detection cache ~5 min; 20 epochs on 6,113 images at 640/batch 16 **6.5 hours** (~19 min/epoch; ultralytics forces `workers=0` on CPU). `pip install torchvision` from PyPI does not match a torch installed from the cpu index — install `torchvision==0.29.0+cpu` from `download.pytorch.org/whl/cpu` or the validator dies on `torchvision::nms does not exist`.
