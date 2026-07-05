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
- **Deps required:** `pip install numpy onnxruntime pillow opencv-python-headless` (and `ultralytics torch` to retrain). `evaluate_subject_detector.py` (imported by the eval script) was deleted in a past "Update skills" commit — restore it from git history if missing.
- **Eval gotcha:** if `cv2` (opencv) is NOT installed, the spectral-saliency fallback returns `None`, so every gated image (~25%) is *silently dropped* from the eval → inflated subset score. Always install opencv.
- **Image fetch (this env):** `static.inaturalist.org` and `firebaseio.com` are blocked by egress policy; the S3 mirror `inaturalist-open-data.s3.amazonaws.com` works. Originals rate-limit under high concurrency — use ≤8 workers, retries, and fall back to `medium`/`large` size (normalized boxes are size-independent since YOLO runs at 640).

### Session 2026-06-26: algorithm tuning (no improvement)

**Baseline: 0.918 on 328/402 images** (74 blocked at static.inaturalist.org, now resolved via S3 mirror)

Tried: algorithm variants (top1, sal_isect, smallest), 8 custom post-processing algorithms, 504-config parameter sweep, TTA (flip variants). All within ±0.001. GPU retraining not available (no CUDA; CPU 8–9 min/epoch). No changes deployed.

### Session 2026-06-27: MPS retraining

**Baseline: 0.700 on 605 Firebase images** (union+pad=0.08 optimal; deployed union+pad=0.03 ≈ same)

MPS (Apple Metal) works for training: ~25s/epoch vs 8–9 min CPU. `retrain_from_cache.py` fixed: `device="mps"`, removed `set_classes()` (YOLO World-only), export float32 ONNX.

### Session 2026-06-29: retrain yolov8n on user crop boxes — DEPLOYED ✅

**The win: retrain.** Fine-tuned `yolov8n.pt` directly on the 605 user crop boxes as single-class labels (515/90 train/val split, CPU ~100–120 s/epoch on 4 cores, 71 epochs w/ early-stop, ~2.3 h). Exported float32 ONNX (drop-in: identical `[1,3,640,640]→[1,5,8400]` signature) and replaced `ios/iNaturalistReactNative/yolov8n.onnx`.

Honest held-out (90-img val) comparison, **forced-YOLO** (no gate/fallback, to remove the saliency confound — see below): old **0.683 → new 0.747** (+0.064); recall 0.800→0.865, precision 0.447→0.512, zero-detection images 9→2. Full-pipeline (gate 0.25 + fallback): old 0.694 → **new 0.763**. The repro recipe is `retrain_from_cache.py` (default base now `yolov8n.pt`, was the incompatible/missing `yolov8s-worldv2.pt`).

**What did NOT work / dead ends:**
- *Post-processing & algorithm tuning* (gate/union-thresh/maxk/pad sweeps): only ±0.005–0.007, i.e. noise. Lowering `YOLO_UNION_THRESH` 0.6→0.4 helps the *old* model but not the retrained one; reverted. Best new-model post-proc (uthr 0.5/k 2/pad 0.08 = 0.768) is within 90-sample noise of the originals (uthr 0.6/pad 0.03 = 0.763) — left constants at defaults.
- *Gate tuning is a trap.* Raising the gate "improves" the eval because the eval's spectral-saliency fallback has recall ≈0.996 (huge boxes), so sending more images to fallback inflates the recall-weighted score. **The app's real fallback is Apple Vision attention saliency, not spectral** — unavailable on Linux — so any tweak that changes firing rate is non-transferable. Compare *models* with forced-YOLO (ignore gate+fallback) for an honest box-quality number.
- *Undertraining misleads.* At epoch ~29 the new model looked only ~tied (0.70) and even regressed at epoch ~40 (firing-rate confound); it only pulled clearly ahead after convergence (~epoch 51 best). Don't judge a CPU run before it finishes.
- *Full-605 eval of the retrained model reads 0.874 but is meaningless* (515/605 were training images → leakage). Use the held-out val numbers.

**Brightness: BLOCKED as of this session — could not tune.** The brightness labels live only in Firebase at `{CROP_LOG_FIREBASE_URL}/brightness_log.json`; `firebaseio.com` is denied by this environment's egress policy (proxy `connect_rejected`), and there is no committed fallback (unlike `crop_training.json`). Without the human-chosen brightness labels there is no ground truth to fit `TARGET_LUMINANCE`/the adjustment curve in `useAutoBrightnessForUri.ts`, so no validated change was possible. To make progress next time: export `brightness_log.json` to a committed file (mirror the crop-log fallback pattern) from an environment that can reach Firebase. **Update: unblocked 2026-07-04, see below** — `firebaseio.com` was reachable in that session's environment.

### Session 2026-07-04: refreshed dataset retrain (DEPLOYED ✅) + brightness model (DEPLOYED, low-confidence)

**Setup differences from prior sessions:** this environment could reach `firebaseio.com` directly (no S3-mirror workaround needed for the JSON endpoints, only for original image bytes), so both `crop_log.json` and `brightness_log.json` were pulled live. `scripts/pull_crop_log.py` merged Firebase into `crop_training.json`: 605 → **2502 images**. `scripts/prefetch_images.py` (new) downloads the whole set concurrently (8 workers) into `/tmp/inat_eval_cache` before running any eval/retrain — the serial per-image download inside `evaluate_subject_detector.resolve_image` is far too slow at this dataset size (2502 images), don't run the eval scripts cold.

**Subject detector — retrain on the refreshed 2502-image set, DEPLOYED.**
Baseline (previously-deployed model, full 2502-image set, deployed config pad=0.03/union): **0.798**. Best padding for that same model was only 0.800 at pad=0.10–0.12 — a ~0.002 gain, within the noise band established in the 2026-06-29 session; left padding at 0.03.

Retrained `yolov8n.pt` from scratch (not from the already-finetuned weights) on all 2502 images via `retrain_from_cache.py` (default args), 85/15 split (2126/376), MPS, batch=8, patience=20. **78 epochs completed in 5.6 hours, best at epoch 58.** Training is CPU/GPU-bound but wall-clock was inflated by repeated ~15-minute stalls that turned out to be **system sleep**, not slowness — `caffeinate -i` alone did not prevent it (probably clamshell/lid-close sleep), but `caffeinate -d -i -s -w <pid>` (also blocks display + system sleep) fixed it immediately. **Always launch long training runs under `caffeinate -d -i -s -w <pid>` from the start.**

Honest held-out comparison on the exact 376-image val split (`scripts/eval_heldout_val.py`, new — loads YOLO-format labels straight from `/tmp/inat_finetune_local/labels/val`, so it doesn't depend on the eval cache matching by URL), **forced-YOLO** (no gate/fallback):
old **0.806 → new 0.829** (pad swept 0.00–0.30 for both); recall 0.900→0.914, precision 0.431→0.487, no-detection images 56/376→26/376. Clearly above noise. Model installed to `ios/iNaturalistReactNative/yolov8n.onnx` and committed.

**Brightness — unblocked, but data is small and biased. Shipped a model anyway at the user's request.**

`brightness_log.json` had only **21** human labels (`{url, brightness}` — the ideal multiplier a user picked with `MainMediaDisplay`'s manual slider before hitting save; independent of any auto-suggestion, since that screen starts the slider at a hardcoded 1.0 regardless of `useAutoBrightnessForUri`). Committed as `brightness_log_raw.json` (mirrors the `crop_training.json` fallback pattern).

*First pass — full-image luminance (matches what the human actually looked at in the slider UI):* correlation between mean luminance and the chosen multiplier was **positive** (r=0.46) — the opposite sign from the deployed formula's assumption (`TARGET_LUMINANCE/luminance`, which assumes darker → brighten more). Two images with nearly identical luminance (0.271) got opposite human choices (0.79× and 1.87×). A from-scratch LOOCV search (`scripts/explore_brightness_models.py`) over ~20 candidate models (linear/log-linear/multivariate regression on mean/geomean/median/std/percentiles/shadow-highlight fractions, highlight-protection exposure metering, k-NN) found **nothing beat a naive constant-mean prediction** (LOOCV MAE 0.673 constant vs 0.641 best content-model) — recommended *not* shipping, since the 21 labels are a biased sample (only logged when a user felt the auto-brightness was wrong, mostly under-exposed) and a model fit to that sample would over-brighten already-correct photos.

*User overrode: "ship it, I will label more data based on the errors."* Also asked to make sure the algorithm runs on the **detected subject crop**, not the full frame (this is what `ObsImage.tsx`'s `useAutoBrightnessForUri` call already does in production — `brightnessCrop` is the subject-detection box). Recomputed the same feature/LOOCV search over crop-region pixels instead of full-image (`scripts/explore_brightness_crop_models.py`): correlations flipped to the theoretically sensible sign (crop `p10`, i.e. shadow depth, correlates **negatively** with the chosen multiplier, r=−0.475 — darker crop shadows → more brightening), and `loglinreg(p10)` won clearly: **LOOCV MAE 0.573 vs 0.641 constant** (~11% better), the best of every candidate tried on either full-image or crop features.

Deployed: `adjustment = exp(-1.463 × shadowP10 + 0.804)`, clamped to `[0.4, 3.0]` (same safety bounds as before), where `shadowP10` is the 10th-percentile luminance of the subject crop. Required a native change since the old `measureAverageLuminance` only computed a mean: renamed to `measureShadowPercentile` in `ImageCropper.m`, same 64×64 sampling geometry (crop-parameterized already), now `qsort`s the 4096 samples and returns the 10th-percentile value. `useAutoBrightnessForUri.ts`'s `computeAdjustment` replaced with the log-linear formula (constants `SHADOW_ADJUSTMENT_SLOPE`/`INTERCEPT`).

**Caveat for next session:** n=21 is small and this is a first cut, not a validated win — LOOCV MAE improvement over baseline is real but modest, and there was no held-out test beyond LOOCV on the same 21 points. If more labels come in, refit by rerunning `scripts/explore_brightness_crop_models.py` against `brightness_log_raw.json` (or refresh it from Firebase first) and update the two constants in `useAutoBrightnessForUri.ts`.
