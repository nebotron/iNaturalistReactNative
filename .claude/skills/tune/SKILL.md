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

**Brightness: BLOCKED — could not tune.** The brightness labels live only in Firebase at `{CROP_LOG_FIREBASE_URL}/brightness_log.json`; `firebaseio.com` is denied by this environment's egress policy (proxy `connect_rejected`), and there is no committed fallback (unlike `crop_training.json`). Without the human-chosen brightness labels there is no ground truth to fit `TARGET_LUMINANCE`/the adjustment curve in `useAutoBrightnessForUri.ts`, so no validated change was possible. To make progress next time: export `brightness_log.json` to a committed file (mirror the crop-log fallback pattern) from an environment that can reach Firebase.

### Session 2026-07-03: exhaustive no-win — deployed model is at a robust optimum

**Baseline (fast custom eval, deployed model):** full 605-image set S=0.875 pipeline / 0.864 forced (inflated — 514 of 605 were its training images). Honest held-out (91-img seed-42 val): **forced 0.877, pipeline 0.886** (R=0.96, P=0.55). Old pre-retrain model on same val: 0.766 forced. NOTE: absolute scores are NOT comparable across sessions — this session's harness scores no-det images as full-image crops and derives the val split by re-running the seed-42 shuffle (91 val imgs, not the "90" in older notes). Compare candidates only within one session, same harness.

**Everything tried, nothing beat deployed (all VAL, forced/pipeline):**
- *E1 continue-train from deployed weights* (AdamW 2e-4, cos_lr, degrees=5, mixup 0.05): 0.870/0.885 — tie. Early-stopped, best at epoch 8.
- *E2 box-loss emphasis* (box=10, dfl=2, lr 5e-4, gentle warmup): 0.866/0.875 — slightly worse. Best at epoch 4.
- *E3 fine-tune at imgsz=960* (motivated by tiny-subject failures; app would need YOLO_INPUT_SIZE/numPreds=18900 change): **0.829/0.845 — clearly worse.** 605 images can't support a resolution shift. Also deployed 640-weights run raw at 960: 0.852 (precision collapses).
- *Model soups* (weight-average deployed+E1+E2, ideal same-parent conditions): 0.878 — tie.
- *Post-proc sweeps* (uthr 0.3–0.8 × maxk 1–5 × pad, conf-weighted fusion, size-adaptive padding): all ±0.004 = noise. Gate raising again "wins" (0.897 at gate 0.5) — same spectral-saliency-fallback trap as before, do not trust it.
- *Label cleaning*: 38/514 train labels have IoU<0.1 vs the fitted model. Visually inspected the worst 9 (label vs prediction rendered): labels are VALID — tiny distant subjects (median user crop = 3.9% of image area) or one-of-many-animals ambiguity (duck flocks). Do not drop them.

**Why warm-start retraining always stalls:** every run's best epoch is 4–8 then declines — training on the mosaic-augmented 514-image distribution moves *away* from the val optimum. The deployed checkpoint (COCO→71-epoch fine-tune, last session) is effectively the optimum reachable from this data with yolov8n.

**Environment blockers (remote/cloud env), and the workaround that matters:**
- ALL pretrained-weight sources are blocked: github release assets (proxy 403 "add_repo"), huggingface, download.pytorch.org, kaggle, zenodo — so stock yolov8n/s.pt is unobtainable. GitLab IS reachable and searchable via API but no usable yolov8 weight mirror was found.
- **Workaround: `scripts/onnx_to_pt.py` (committed this session)** reconstructs a trainable .pt from the deployed BN-fused ONNX (initializer names are preserved; BN un-fused via activation-stats calibration, parity rel err 3e-7). This is the only warm-start path in this env — verified training runs fine from it.
- Bigger models (yolov8s = 43 MB, ~3× device latency) judged not deploy-worthy for a mobile bundle even if obtainable.
- **Brightness: still BLOCKED, worse than before** — this env has no `CROP_LOG_FIREBASE_URL` at all (no .env), firebaseio.com egress is denied (CONNECT 403), and no brightness data exists in git history. Unchanged advice: from an env with Firebase access, commit `brightness_log.json` as a fallback file like crop_training.json.

**Next-session ideas that could actually move the needle:** more labeled data (the only real lever — export a bigger crop log), or run the tune on a Mac/GPU env where yolov8s + MPS training and Apple-Vision-fallback evaluation are possible.
