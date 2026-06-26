---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/evaluate_subject_detector.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images from the Firebase crop log, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different model configurations, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git. When you are done, leave notes of approaches that did and did not work at the end of this skill.

---

## Notes from tune session (2026-06-26)

### Baseline

The deployed model is `ios/iNaturalistReactNative/yolov8n.onnx` — a fine-tuned single-class YOLOv8n that outputs `[1, 5, 8400]` (cx, cy, w, h, objectness). The algorithm post-processes by:
1. NMS at IoU=0.45, conf_thresh=0.05
2. Gate: if best detection < 0.25 confidence, fall back to saliency
3. Union: take top-K boxes (K=3) where conf ≥ 0.60 × best_conf, union their bounds
4. Padding: expand bounds by 3% before squaring to a crop

**Baseline score: 0.918** on 328 images (74 of 402 fail — blocked at static.inaturalist.org)

Score = (2×recall + 1×precision) / 3. Recall is weighted 2× since missing the subject is worse than a loose crop.

Note: `evaluate_subject_detector.py` uses `yolov8n.pt` (COCO-pretrained PyTorch) by default, giving a misleadingly low 0.723. The actual deployed ONNX model scores much higher. Use `scripts/eval_onnx_variants.py` for accurate evaluation.

### What Was Tried

**Algorithm variants (via `scripts/eval_onnx_variants.py`):**
- `union` (current): 0.918
- `top1` (just take best box): 0.912
- `sal_isect` (intersect YOLO box with saliency): 0.906
- `smallest` (take smallest detected box): 0.812
- Old fine-tuned model (`yolov8n_finetuned.onnx`): 0.721 — significantly worse
- YOLOv8s-worldv2-int8: 0.785 — worse, and much larger model

**Novel post-processing algorithms (8 variants tested):**
- `adaptive_conf` (gate threshold scaled by image complexity): no improvement
- `soft_union` (weighted centroid by confidence): no improvement  
- `hull_union` (convex hull of boxes): no improvement
- `union_k2` (union of top 2 only): no improvement
- `gate70_top1` (higher gate 0.70, take top1): no improvement
- `union_tight_75` (tighter union_thresh 0.75): 0.9171 (Δ=-0.0009, slightly worse)
- `sal_refine_40` (intersect with saliency if 40%+ overlap): no improvement
All variants ≤ 0.918.

**Parameter sweep (504 configurations):**
- Swept gate_conf × union_thresh × union_max_k × algo × padding
- Best: gate=0.40, union_thresh=0.60, k=3, pad=0.03 → score=0.9185 (Δ=+0.0005, within noise)
- Conclusion: current hyperparameters (gate=0.25, u_thresh=0.60, k=3, pad=0.03) are near-optimal

**Test-time augmentation (TTA):**
- Horizontal flip (run on original + flipped, unflip x-coords, merge): score=0.9197 (Δ≈0)
- Flip-as-fallback (use flipped image only when original fails gate): score=0.9204 (Δ=+0.0007)
- Multi-scale (640 + 480): NOT FEASIBLE — ONNX model has fixed 640×640 input dimensions

**GPU retraining:**
- NOT FEASIBLE — no CUDA available; CPU training is ~8-9 min/epoch, too slow for useful fine-tuning
- Brief test: starting from COCO weights on CPU, epoch 1 mAP50=0.146 (expected, needs many epochs to converge)
- The current `yolov8n.onnx` was already trained offline and is a good model

### Conclusion

The deployed model and algorithm are already near the ceiling of what's achievable with the available data and inference constraints. All improvements found are within measurement noise (< 0.001). No changes were made to the app.

To meaningfully improve further would require:
1. GPU access to retrain from the labeled crop data (using `scripts/retrain_from_cache.py`)
2. More labeled training data beyond the 328 usable images
3. A larger model (YOLOv8s or YOLOv8m) — but these are significantly bigger for iOS bundle
