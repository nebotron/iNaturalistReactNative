---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/eval_onnx_variants.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune sessions

### Setup

- Model: `ios/iNaturalistReactNative/yolov8n.onnx` — single-class YOLOv8n with a **dynamic input shape** (`[batch, 3, height, width]` → `[batch, 5, anchors]`; 8400 anchors at 640×640), so views run on canvases smaller than 640². Any H, W that are multiples of 32 work. Export with `dynamic=True` (`retrain_from_cache.py` and `score_checkpoint.py` do). Its weights are stored as fp16 (`scripts/onnx_weights.py`; ORT casts them back to fp32 at load) to halve its size: the crop score on the newest 991 log images was identical (int8 lost 0.013). `retrain_from_cache.py` installs new exports that way and `onnx_to_pt.py` reads them back.
- **Metric (since the IoU session): score = IoU of the predicted square crop with the human's crop.** It replaced `(4·recall + 1·precision) / 5`, which hid the small-subject problem. Every score in the sessions below that one is on the old metric and is not comparable.
- **Since the zoom-in session the IoU counts only pixels inside the image.** The human crop is logged clipped to the image, so the predicted square is clipped the same way before IoU (`crop_score` / `clip_to_image`, and `sweep_crop.score`), and `bounds_to_crop` now letterboxes around the image centre exactly as the TS does (it used to centre on the subject). Scores before that session are about 0.015 lower than they would be now; the zoom-in session's numbers are given both ways.
- Post-processing (since the fewer-views session): the detector runs on 3 views, named `[o|h]<L><sq|t><S>` (photo as is / mirrored, its longer edge drawn at L px, on a fixed S×S square or a *tight* canvas whose sides are the drawn photo's rounded up to 32 and capped at S): `h640t640`, `o914t576` (1/0.7× zoom-in, centre 576²), `o320sq384` (2× zoom-out on a 384² grey square). Each is NMS'd (IoU=0.45, conf=0.05, top 16), the views' boxes are merged by weighted box fusion (IoU 0.40, conf = sum / 3) and the top fused box is the subject (no confidence gate; when nothing clears 0.05 the app shows the whole photo — the Vision saliency fallback was removed after it fired 0 times in 3,400 field detections and scored a wash against a centre square. `sweep_crop.py` still scores spectral saliency for those photos, a negligible mismatch) → square crop circumscribing the box. No widening, no padding. `cache_detections.py` (`VIEWS`, `parse_view`, `detect_view`, `fuse_views`) mirrors `ImageCropper.m` (`kYOLOViews`); change both together. `SINGLE_VIEW=1` caches the old one-view (`o640sq640`) detections.
- **The squaring is TypeScript, not ObjC.** `ImageCropper.m` returns *bounds*; `src/sharedHelpers/subjectBoundsToNormalizedCrop.ts` turns them into the crop (padding 0, set in `detectSubjectInImage.ts`). Geometry changes belong there — cross-platform, unit-testable. `scripts/evaluate_subject_detector.py:bounds_to_crop` mirrors it; a 4-case node-vs-python diff keeps them honest.
- Eval: `scripts/cache_detections.py MODEL.onnx OUT.npz` (~20 min for 11.7k images with the 3 shipped views, 4 procs) then
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
- **hflip TTA:** +0.002 for double the on-device inference. **Letterbox pad colour** 114 (training) vs 127 (`ImageCropper.m`): no measurable difference, left alone. **Spectral saliency vs a plain centre square** on gated images: 0.8232 vs 0.8209 — a wash. (It was kept at the time; it has since been removed, since a wash means the simpler choice wins.)
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

### Session: small subjects — retrain with small-subject oversampling, held-out 0.8412 → 0.8425

**Prompt:** "performs very poorly for subjects very small in frame." Log is now 10,743 entries / **8,454** evaluable. Held-out = last **1,500** (`--heldout-tail 1500`; URL list verified identical to `cache_detections --slice=-1500:`), which neither the old nor the new weights trained on.

**Diagnosis — read this before chasing small subjects again.** Bucket by truth size `max(w·W, h·H)/max(W,H)`:
- Truths under 0.10 score worst (0.815 held-out) with precision ~0.10: they get a near-full-frame crop. Only ~29% pass the gate; median top-box confidence on them is 0.37.
- The detector usually *does* find them (top box contains the truth centre ~91%, median size ratio ~1.0), but **low-confidence small boxes really are worse than the fallback**: conf 0.3–0.4, box <0.1 → detection 0.67 vs fallback 0.81. The gate is right; confidence is the problem.
- **The metric caps the upside.** Truth-as-box (perfect detector) on held-out small truths scores only 0.892 vs 0.80 for fallback, because of the 4:1 recall weighting and β. Watch precision and detection rate on the <0.10 bucket as well as the score — that's what the user sees.
- Truths under 0.05 essentially don't exist (5 of 2,335): the crop UI seems to have a minimum size.

**What shipped:** new weights (warm start, 16 epochs, AdamW 1e-4, `--scale 0.4 --small-oversample 1` = training images whose truth is <0.15 of the frame appear twice; 1,792 of them) and `YOLO_GATE_CONF` 0.50 → **0.45**. β=0.92 re-checked: still optimal for both models.

| held-out 1,500 | old | new |
|---|---|---|
| score (gate picked by 5-fold CV inside the tail) | 0.8412 | **0.8425** |
| truth <0.10: score / precision / detected | 0.815 / 0.102 / 29% | 0.820 / 0.143 / 37% |
| truth 0.10–0.20 | 0.843 / 0.254 / 50% | 0.846 / 0.308 / 60% |
| whole log (memorization-inflated) | 0.8608 (p 0.384) | 0.8626 (p 0.417) |

Every bucket delta's bootstrap CI includes zero; the overall gain is within noise, but precision and detection rate rise consistently below 0.35, and the large-subject buckets dip slightly (−0.003 to −0.005, also not significant).

**What did not work**
- **Zoomed second pass** (`scripts/cache_zoom.py`: re-detect inside a square 3× the top box, upscaled to 640): the zoomed boxes come out 10–20% *tighter* than the truth, so recall drops. Zoom confidence doesn't tell right boxes from wrong ones either. Best variant: −0.002 overall on unseen photos, +0.006 on the <0.10 bucket. Not worth a second inference.
- **2×2 tiled inference** (cached by the same script): no gain.
- **Hedged crop for low-confidence small boxes** (k× the box, centred on it, in place of the fallback): every k in 1.5–4 and cmin 0.15–0.35 lost overall. Low-confidence boxes are too often on the wrong object.
- **A size-dependent gate:** the per-(conf, size) table shows no cell below conf 0.5 where detection beats the fallback for small boxes.
- **5-parameter `calibrate_crop.py` at gate 0:** −0.029. Keep the hard gate.

**Ops**
- **The container is reclaimed after ~30 min with no tool activity, and that kills detached training.** `send_later` check-ins don't count as activity: the first attempt died after epoch 1 while waiting on a 100-min check-in. Stay active with chained foreground waits (`timeout 590 bash -c 'while pgrep …; do sleep 30; done'`). Resume a killed run with `YOLO('…/weights/last.pt').train(resume=True)`. `/tmp` and pip installs survived the restart.
- Throughput: 8,746 training images at 640/batch 16 on 4 cores ≈ 30 min/epoch, 16 epochs ≈ 8 h.
- The pre-commit hook runs a full `npm install` on a fresh clone (~2 min) and stalls the shell; expect it.

**Next idea, if small subjects still matter:** the labels have a minimum size and the detector is accurate but under-confident on small subjects. Fine-tune with a loss that weights small boxes more, or add a *small-box-specific* confidence recalibration (Platt on conf × log size) fitted strictly on held-out photos. Both are cheaper than more data, which already looked saturated last session.

### Session: IoU metric, no widening, no gate — small-subject IoU 0.20 → 0.41

**Metric change.** The user asked for IoU scoring and no deliberate widening. `crop_score` in `evaluate_subject_detector.py` and `sweep_crop.score` now return the IoU of the predicted square crop with the human's crop (vectorized and scalar agree to 0.0 over 1,500 images; human crops are square in pixels: median aspect 1.000). Recall and precision are still printed as diagnostics. `SIDE_CALIBRATION_EXPONENT` was removed from TS and Python.

**Under IoU the old post-processing is badly wrong.** Held-out 1,500 (the same tail as the previous session):

| config | all | truth <0.10 | 0.10–0.20 | 0.20–0.35 | 0.35–0.50 | ≥0.50 |
|---|---|---|---|---|---|---|
| old weights, gate 0.50, β 0.92 | 0.413 | 0.145 | 0.341 | 0.358 | 0.495 | 0.650 |
| new weights, gate 0.45, β 0.92 | 0.452 | 0.202 | 0.410 | 0.404 | 0.531 | 0.644 |
| old weights, no gate, no β | 0.553 | 0.378 | 0.533 | 0.549 | 0.615 | 0.645 |
| **new weights, no gate, no β (shipped)** | **0.565** | **0.409** | 0.563 | 0.565 | 0.605 | 0.634 |

The IoU-optimal gate is 0: every detection that clears the 0.05 NMS threshold beats the saliency fallback, so the gate was removed from `ImageCropper.m`. Padding 0 is optimal (−0.02 → 0.5638, +0.03 → 0.5623). On IoU the small-subject-oversampled weights from the previous session beat the old ones significantly: +0.012 overall (CI [+0.003, +0.021]) and +0.031 on small subjects (CI [+0.008, +0.054]).

**What did not work (all on IoU, held-out)**
- **Post-processing search** (gate × union threshold × K × top1-below-size × fallback × padding, 1,000+ configs): best 0.5662 vs 0.5650 plain, and 5-fold CV of the selection gives 0.5627. Flat. `top1` alone helps small subjects (0.446) but loses big ones (0.598 vs 0.634).
- **Box re-ranking** by conf × size^a × exp(−b·centre distance): best 0.5664, CV 0.5611. Picking the oracle-best existing box would give 0.655 overall and 0.531 on small subjects, so ranking is a real headroom, but no simple rule captures it.
- **Larger input** (export the same weights at 800/960): 0.543 / 0.502. The weights are tuned to 640's scale; it would need training at that size and ~1.6–2.3× inference.
- **Second retrain** (warm start from the shipped weights, small subjects ×3, 10 epochs, lr 5e-5): small subjects +0.027 (CI [+0.004, +0.051]) but overall −0.006 (CI [−0.015, +0.003]), losing on 0.2+ subjects. Not shipped. **Routing** small first-pass boxes to it doesn't capture the gain (best 0.5667 overall, small 0.406): on small truths the first model's box is often large or misplaced, so they never get routed.

**Where small subjects fail now:** 34% of crops on truths under 0.10 have IoU < 0.1 (wrong object), 20% are 0.1–0.5, 46% are ≥ 0.5. The misses are a detection/ranking problem, not geometry.

**Tooling:** `cache_detections.py` takes `YOLO_INPUT_SIZE` from the environment to test other input sizes.

### Session: test-time augmentation — held-out 0.5587 → 0.5808, small subjects 0.383 → 0.44

**Log:** 10,853 entries / **8,562** evaluable. Held-out = last 1,500 (the shipped weights trained on everything before the last ~1,608). Baseline (deployed weights, one view): **0.6624** whole log, **0.5587** held-out.

**What shipped: 3-view TTA with weighted box fusion** (`ImageCropper.m`, mirrored by `cache_detections.py`). Run the detector on the photo, its mirror, and a 1.5× zoomed-out copy (photo drawn at 1/1.5 scale in the centre of the letterbox); NMS each; fuse all boxes by WBF (IoU 0.40, conf = sum / 3); take the top fused box. Held-out **0.5808** (+0.022, bootstrap CI excludes 0), whole log **0.6812**. `eval_onnx_variants.py` on the whole log agrees: 0.662 before (`union`, one view), 0.681 after — but takes ~1.5 h per run, vs minutes for `cache_detections` + `sweep_crop`. Every size bucket gains; truths <0.10 gain most (0.383 → 0.445 in the exploratory run). Cost: 3 inferences instead of 1.
- Why it works: averaging steadies box edges, and a box found in all three views outranks a one-view false positive. It is the ranking fix the IoU session was looking for: a learned linear re-ranker on top of the fused boxes adds only +0.001 (CV), where on single-view boxes it added +0.004 and a GBM +0.008.
- After fusion, take **top-1**, not the union: union K=3 at 0.6 loses 0.012. Padding 0 and no gate remain optimal.
- View choice (held-out, WBF 0.4, top1): o+h 0.572, o+zoom1.5 0.572, **o+h+zoom1.5 0.584**, o+h+zoom2.0 0.575, o+h+zoom1.5+h·zoom1.5 0.581, six views 0.578. Three views is the sweet spot; mirrored-zoomed views add nothing.
- WBF IoU 0.25–0.55 and union settings after fusion: flat (CV of the best of 200 configs 0.5829 vs 0.5837 default).
- The C fusion loop was diffed against `fuse_views` on 1,991 random box sets (max 5e-6). Implementing the zoom in the letterbox vs padding the image first moves the score by 0.003 — resampling noise, so don't chase sub-0.005 differences between eval variants.

**What did not work**
- **Bigger / newer architectures on CPU.** yolo11s trains at ~34 s/batch here (≈5 h/epoch) — infeasible. yolo11n from COCO (same [1,5,8400] head, so a drop-in) scored 0.398 / 0.429 after epochs 1 / 2 vs 0.58 for the warm-started v8n lineage; stopped. The years of warm-started fine-tuning are worth more than a better backbone.
- **Re-rankers** (see above) and **post-fusion padding/union** sweeps.
- **Warm-start retrain aimed at ranking** (`--cls 1.0`, i.e. double the classification-loss gain; 8 epochs, AdamW 5e-5, scale 0.4, small ×2), scored with TTA on held-out: epochs 1/2/4/8 = 0.5743 / 0.5771 / 0.5810 / 0.5803 vs 0.5808 deployed; bootstrap delta +0.0002, CI [−0.009, +0.009]. A tie, as every retrain on this log has been since the warm-start fix. Not shipped. **Stop spending 5 h CPU retrains on recipe tweaks** — the data are saturated for yolov8n; only a GPU (bigger backbone) or a new kind of signal is likely to move it.

**Ops**
- The container restarted mid-session (uptime reset, all processes gone) even with tool activity every 10 min; `/tmp` and pip installs survived. Re-check `pgrep` after any gap and restart the run.
- Don't run `eval_onnx_variants.py` alongside training: it takes every core and doubles epoch time (3.4 → 8 s/it). `pkill -f retrain_from_cache` also kills the shell whose own command line contains that string — kill by PID.

### Session: zoomed-in TTA view + retrain on the bigger log — held-out 0.5464 → 0.5672

**Log:** 13,498 entries / **11,187** evaluable. The previously deployed weights trained on evaluable indices `[0, 7062)`, so `--slice=7062:` (4,125 photos) is a large pool they never saw; the new weights hold out the last **2,000** (`--heldout-tail 2000`, URL list verified identical to `--slice=-2000:`). Baseline (deployed weights, 3 views): whole log **0.6410**, unseen 4,125 **0.5395**, tail 2,000 **0.5464**, photos it trained on 0.7002.

**What shipped** (scores on the 2,000-photo tail neither model trained on):

| | 3 views (o, h, z1.5) | 4 views (o, h, z2.0, z0.7) |
|---|---|---|
| previous weights | 0.5464 | 0.5592 |
| new weights | 0.5528 | **0.5672** |

Total +0.021 (bootstrap CI [+0.013, +0.029]); whole log (memorization-inflated) 0.6410 → 0.6588; the fp16 install scores the same as the fp32 export (0.5673 vs 0.5672); views alone +0.013 to +0.014, weights alone +0.008 (CI [+0.002, +0.015], P 0.996). Every size bucket gains; ≥0.5 subjects 0.607 → 0.642, <0.10 subjects 0.383 → 0.423. On-device cost: the app log's `subject_detection_timing` shows ~37 ms per view, so ~120 → ~160 ms per photo.

- **A zoomed-in view is the new TTA signal.** `zoom < 1` in `preprocessForYOLO` draws the photo magnified and the canvas clips it, so it is a pure table change in `ImageCropper.m`; PIL's paste at a negative offset does the same in `cache_detections._letterbox`. Found with a per-view cache (all 11 candidate views NMS'd separately, then any subset fused in Python in seconds — a scratch script; worth promoting into `scripts/` if TTA is revisited). On the 4,125 unseen photos: o,h,z1.5 0.5395; +centre 0.8 0.5456; o,h,z2,c0.8 0.5489; **o,h,z2,c0.7 0.5522**; o,h,z1.75,c0.7 0.5514; o,h,z2,c0.6 0.5492; five or six views 0.548–0.550. Picking on a random half and scoring the other half gave +0.009 to +0.012 every time, so it is not a selection artefact. The crop emulation and the exact magnified draw agreed (0.5522 vs 0.5525).
- **Fusion knobs stay flat:** WBF IoU 0.30–0.45 within 0.0015, per-view weights 0.7–1.3 within 0.001, ranking clusters by max instead of sum −0.004.
- **Retrain recipe:** warm start, 10 epochs, AdamW 1e-4 → 5e-6, `--scale 0.4 --small-oversample 1 --batch 16 --no-val` (new flag: skips ultralytics' per-epoch mAP validation; `last.pt` is installed). 11,484 images/epoch ≈ 31–40 min on 4 cores, 6.4 h total. Tail score by epoch (4 views): 1 0.5570, 3 0.5592, 5 0.5648, 7 0.5679, 10 0.5672. ultralytics 8.4.218 converted fine: `onnx_to_pt` matched ORT and the log said "Transferred 355/355". **So more data did help this time** (+30% labelled photos → +0.008), unlike on the old recall-weighted metric.

**Measurement artefact (fixed at the end of this session — the metric now clips): letterboxed crops were scored against clipped truths.** The logged human crop is the visible square *intersected with the image* (`imageZoomTransformToNormalizedRect` clamps the corners to [0,1]), so 13% of truths are rectangles up to 1.5:1. Our square runs past the image on 14% of photos and is scored with its off-image area in the union; those photos score 0.42 vs 0.57. Clipping the predicted square to the image before IoU adds +0.018, but the visible pixels are identical — it is the metric, not the crop, that changes. The real alternative, "never letterbox" (shrink the square to the short side), wins +0.009 on the current metric but *loses* once both crops are compared as visible regions, so it was not shipped. **Fixed:** IoU is now scored on square ∩ image. Under it, with the same detection caches: whole log 0.6563 → **0.6717**, held-out tail 0.5615 → **0.5797** (+0.018, CI [+0.010, +0.026]); views alone +0.009 to +0.012, weights alone +0.009 (CI [+0.002, +0.015]). Scalar and vectorized scorers agree to 5e-8 over 11,187 images, and `bounds_to_crop` matches `subjectBoundsToNormalizedCrop.ts` to 0.0 on four cases including two letterboxes (run the TS standalone with `node --experimental-strip-types` after stripping its imports — jest needs Realm's native build). Re-sweeping post-processing under the clipped metric on the tail: padding +0.03 and gate 0.10 each +0.002 over the shipped 0/0, tuned on the same photos, so noise; the shipped settings stay.

**What did not work**
- **Box geometry** under IoU: side power law β 0.85–1.1 (β=1 best by 0.003+), shifting the centre toward the image centre (α ≠ 0 loses), padding. When the right object is found the median predicted/true side ratio is 0.96–1.04 in every size bucket — the misses are wrong-object picks (38% of <0.10 subjects, 11–15% elsewhere), not geometry.
- Oracle over existing fused boxes on unseen photos is 0.655 vs 0.540 — ranking is still the headroom, as the IoU session found.

**Ops**
- Running anything CPU-heavy alongside training slows it 4–6× (2.2 → 13 s/it). Total CPU is conserved, so it is fine for short jobs, but budget it.
- Epoch checkpoints are 0-indexed: `epoch4.pt` is the end of the 5th epoch.

### Session: fewer, cheaper views — 4.0 → 1.9 inferences per photo, score tied on unseen photos

**Prompt:** improve the score and, if possible, run the model fewer times per photo to save CPU and battery. Log: 13,981 entries / **11,669** evaluable. The deployed weights trained on evaluable indices `[0, 9187)` (the previous session's 11,187 minus its 2,000-photo tail; 11,190 of today's evaluable photos were in that session's log, so this boundary is right to within a few photos), so `9187:` (2,482 photos) is the unseen pool. The first commit kept the weights and only re-exported them with a dynamic input shape. A retrain followed; see the end of this section.

| | runs | cost (640² = 1) | whole log | unseen 2,482 | unseen truth <0.10 (n=313) |
|---|---|---|---|---|---|
| previous: o, h, z2, z0.7, all on 640² | 4 | 4.00 | **0.6678** | 0.5807 | 0.410 |
| **shipped: `h640t640`, `o914t576`, `o320sq384`** | **3** | **1.90** | 0.6565 | **0.5820** | 0.400 |

Unseen delta +0.0013, 95% CI [−0.005, +0.007]: a tie at 48% of the compute. Every bucket from 0.2 up gains a little, and the two smallest lose a little (−0.010 and −0.006, CIs include 0). The whole-log drop (−0.011) is all on photos the model trained on (−0.015 there): it learned them through exactly the 640² square letterbox it was trained on, so anything else scores lower on them. Single `o640sq640` vs `o640t640` shows the same pattern: +0.001 unseen, −0.0075 trained-on. Do not read the whole-log number as a regression. `scripts/cache_detections.py` with the installed fp16 file reproduces the per-view sweep exactly (0.6565 / 0.5820).

**What worked**
- **A per-view cache** (`scripts/cache_views.py`, promoted from last session's scratch script): every candidate view is run once and its NMS'd boxes stored separately. Then `scripts/sweep_views.py` scores any subset, fusion or cascade in seconds, charging each photo its real canvas cost. 16 views × 11.7k photos took 62 min on 4 cores, and a second batch of 11 took 45.
- **A dynamic-shape export plus tight canvases.** Re-export with `dynamic=True` (`onnx_to_pt.py` → `YOLO(pt).export(…, dynamic=True, opset=12)` → `store_fp16`). It matches the old file to 2.4e-4 at 640², and torch at 384², 512², 480×640. Then draw each view on the smallest canvas that holds it. For 1× views the grey letterbox was pure waste: `o640t640` (0.73 cost on 4:3 photos) scores the same as `o640sq640` on unseen photos.
- **Smaller views carry the TTA.** On the cost/score Pareto front, every set near the old score was one plain view + a cropped zoom-in + a small zoom-out. The zoom-in only needs the centre of the photo (subjects are rarely at the edge), so `o914t576` costs 0.80, not 0.97, and the zoom-out only needs a little grey around it, so `o320sq384` costs 0.36, not 1.0.
- **Pick on unseen photos, then sanity-check by mirror pairs.** Swapping o ↔ h on one view moved unseen scores by up to 0.0075, which is the selection noise floor at n=2,482. Picking the best ≤2.0-cost subset on a random half and scoring it on the other half lost 0.000–0.012 against the old set. So treat any 3-view set within ±0.006 of the old one as a tie, and choose by cost and by the small-subject bucket. `o914t576` was picked over the cheaper `o800t512` (1.73 cost, same overall score) for that reason: small subjects scored −0.010 against −0.021.

**What did not work**
- **Tight canvas for the zoom-out view.** `o320t640` (the photo at 320 on a 320×256 canvas, 0.19 cost) scores 0.447 against 0.513 for the same photo on a 640² grey square. The model needs grey context around a small drawn photo. 384² recovers it (0.510–0.517), 448² adds nothing more.
- **Early-exit cascades.** Running one view, stopping if the top confidence is ≥ t, and otherwise running the rest saves at most ~0.1 cost at equal score. At t = 0.5 it stops on 44% of photos but loses 0.004. One view's confidence does not say whether the other views would have changed the box.
- **Two views.** The best pairs (`o640t640 + o800t512`, 1.36) lose 0.014 on unseen photos. One view (`o640t640`, 0.73) loses 0.021. Three is the minimum for no loss.
- **Fusion knobs for the 3-view set** (WBF IoU 0.3–0.6, per-view weights 0.7–1.3): within ±0.003, as in every earlier session. Left at IoU 0.40 and equal weights.
- **Heavier zoom-ins** (`o1024t576`, 0.502 alone) and **heavier zoom-in crops** (`o914t512`, 0.511) are worse than `o914t576` (0.531) and `o800t512` (0.538). 512² clips too much of a 1/0.7 zoom.

**Next ideas**
- The views are fixed, so a retrain could be aimed at them: fine-tune with `rect=True` or random-canvas letterboxing so the model stops depending on the 640² square. That might also close the trained-on gap above.
- `subject_detection_timing` in the app log records `viewMs` per view. After this ships, check that the three views take ~0.7 / 0.8 / 0.4 of an old 640² view (~37 ms). If preprocessing (the UIKit draw) dominates rather than ORT, the saving will be smaller than the pixel count says.

**Ops**
- `sweep_crop.saliency_for` writes `/tmp/inat_saliency_cache.npz` without locking. Two sweeps started at once corrupt it (`BadZipFile`). Fill it once before running sweeps in parallel.
- `prefetch_images.py` over 14k entries took ~30 min. Re-running `load_entries` retries the ~56 photos that 404 every time, which is slow and noisy but harmless.

**Retrain (same session, second commit): held-out tail 0.5840 → 0.5885**

Recipe: warm start from the shipped weights; 8 epochs; AdamW lr 1e-4 → 5e-6; `--scale 0.5` (was 0.4, now also covering the 2× zoomed-out view); `--small-oversample 1 --batch 16 --no-val --heldout-tail 2000`. That is 12,076 training images (2,407 small-subject duplicates) at about 27 min per epoch, 3.6 h in total. The log said "Transferred 355/355". The held-out URLs were identical to `--slice=-2000:`, and the previous weights never trained on those photos either, because the tail starts at 9669 and they trained on `[0, 9187)`.

Tail score by epoch, with the 3 shipped views: 1 0.5731, 3 0.5777, 5 0.5834, 7 0.5868, **8 0.5884** (0.5885 after the fp16 install), against 0.5840 for the previous weights. That is +0.0044, 95% CI [−0.002, +0.011], P(better) 0.90. Same shape as every warm-started run so far: below baseline until the learning rate anneals, then a small gain. The largest gain is on small subjects: truth <0.10, 0.393 → 0.412 (n = 247, CI [−0.006, +0.045]). Truth ≥0.5 gains 0.683 → 0.694. The middle buckets are within ±0.006.

- **The 3 shipped views stay right for the new weights.** Pareto front on the tail: the best ≤1.9-cost set is still `h640t640 + o914t576 + o320sq384` (0.5884). The old four 640² views get 0.5917 at 4.0 cost, the same small 4-vs-3 gap as with the previous weights (0.5852 vs 0.5840).
- **Whole log** (memorisation-inflated): 0.6678 (old weights, 4 views) → 0.6565 (old weights, 3 views) → 0.6614 (new weights, 3 views).
- **fp16 rounding is larger on a freshly trained export:** max abs output difference 0.55 on random input, but under 1 px on box coordinates and 1e-3 on confidence for a real photo. The score was unchanged (0.5884 → 0.5885). Comparing one fp16 file with another (as at the start of this session) gives ~2e-4; fp32 against fp16 does not, so don't panic at it.
