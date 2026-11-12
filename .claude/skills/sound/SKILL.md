---
name: sound
description: Download labeled Audio ID clips, evaluate accuracy, and explore ways to improve it.
---

Run `python3 scripts/bird_audio/eval_clips.py` (needs `pip install numpy onnxruntime` and
`ffmpeg`). It downloads every Audio ID label and clip from Firebase, reports the labeled
precision, re-runs `ios/iNaturalistReactNative/audio_id.onnx` on each clip and shows how many
right and wrong detections it would still report. `--windows` adds the scoring variants
(offset averaging, neighbouring runs) at 5x the model runs; use it only when exploring
those, since they haven't helped so far. Report the current
accuracy, then explore ways to improve it: scoring variants (offset averaging, consecutive
runs, thresholds, loudness gates), the geomodel weighting in
`src/components/AudioId/audioIdModel.ts`, and model changes (see
`scripts/bird_audio/birdnet/README.md`). Only ship a change if it drops wrong detections
without dropping right ones, and apply it in `audioIdSession.ts` / `AudioBirdId.m`. Leave
notes of what did and did not work at the end of this skill.

---

## Notes

### Setup

- Labels: `audio_id_labels/<id>` in the Firebase DB from `scripts/firebase_auth.py`
  (unauthenticated reads). Labels made before commit 3b430e1 have no `correct` field and no
  audio; the script derives `correct` from `labelTaxonId`. A label with `noOrganism: false`
  and no `labelTaxonId` means the user only said the ID was wrong.
- Audio: `audio_id_clips/<id>` holds `{format: "m4a", audioBase64}`, the 5 s window of the
  clip's best-scoring run. Decoded AAC is ~704 samples longer and shifted by encoder priming,
  so offset-0 scores differ from the logged confidence; one offset within 0–704 samples
  reproduces it (checked on 2 clips to ±0.01).
- Bird scores are the raw model output (`fuseScore` odds are 1 for birds). The app reports a
  species at ≥ 0.5 (`THRESHOLD` in `audioIdSession.ts`; 0.3 before session 3).

### Session 1 (7 clips with audio, all wrong)

- 23 labels: 4 right (none with audio), 19 wrong, 12 of them "no organism".
- Scores are very sensitive to alignment: shifting the window 1–22 ms moved Barred Owl from
  0.04 to 0.54 on a −50 dBFS clip. Several false positives are near-silent noise.
- mean3 still reported 3/7 wrong clips; requiring a neighbouring run ≥ 0.3 left 2/7; both
  together left 1/7 (Clay-colored Sparrow 0.78, which is stable, so the model is confidently
  wrong there). Nothing measured on right detections yet: there were none with audio, so
  no change shipped. Neighbour scores are low-biased (silence padding); saving ~7 s clips
  would let consecutive runs be tested on real audio.

### Session 2 (16 clips with audio: 3 right, 13 wrong)

- 32 labels: 7 right, 25 wrong. All 16 clips are still 5 s (no 15 s context clips yet).
- Right clips are all Steller's Jay (one user, one place), mean3 0.68–0.93 and nbr 0.67–0.96,
  so every variant keeps them. Still reported (right / wrong): raw 3/7, mean3 3/8, min3 3/6,
  nbr 3/6, both 3/5. Clay-colored Sparrow (4 clips) and Northern Flicker (2, 0.50 and 0.74)
  are the stable confident false positives; nothing in the scores separates them.
- Not shipped: `both`/`nbr` fit the "no right lost" rule here, but the README measured
  consecutive windows losing more recall than they gained on 923 recordings, and 3 right
  clips of one species can't outweigh that. mean3 would also triple inference.
- Tried, not useful: a loudness gate (right clips are −36 to −40 dBFS, wrong ones −18 to −50);
  a raised threshold (would need ~0.65, far above what the README eval supports); top-2 margin
  (most wrong clips have no runner-up above 0.05). Scoring each 2.5 s half (tiled to 5 s) and
  requiring both ≥ 0.3 dropped all 13 wrong and kept all 3 right, but only because the jays
  called throughout: it would drop any single short call, so don't ship it on this data.
- `eval_clips.py` now takes the centered 5 s window and real neighbouring runs from 15 s clips
  (checked on a synthetic 15 s clip: center scores match the 5 s clip). Re-run once those
  arrive; nbr on real neighbours is the next thing to measure.
- Geomodel weighting couldn't be checked: labels carry no location.

### Session 3 (117 labels: 20 right, all birds)

- Use the logged `confidence` in the labels for threshold work: it is the app's real score.
  Clips saved before 3d4ee64 were the newest audio when JS asked, so they lagged the scored
  window by inference + bridge time and often scored far lower (seals: 0.02–0.25 on the clip,
  0.31–0.75 logged). From 3d4ee64 on, clips are the exact window (15 s ones centered on it).
- Non-birds: all 74 labeled were wrong (46 Harbor Seal, 25 Red Fox). The geomodel odds boost
  ((geo / 0.037) ^ 0.4) tripled seal odds near Puget Sound. **Shipped** (1084833): no boost.
  Undoing it on the logged scores (Seattle geomodel, week 39) leaves 28 of 74; on the 700
  `eval_regions.py` recordings non-bird recall 0.777 → 0.754.
- **Shipped** at the user's call: threshold 0.5 (birds and non-birds). Field: right 20 → 18, wrong 23 → 8.
  Recordings: bird recall 0.949 → 0.937, wrong birds per recording 0.74 → 0.57 (0.4: 0.943,
  0.65; field drops 1 right, 5 wrong). A non-bird threshold of 0.5 (no boost) would leave 10 of
  74 wrong for recall 0.706; 0.7 leaves 3.
- To sweep thresholds offline, dump per-window scores and geomodel values for the
  `eval_regions.py` recordings once (~45 min on 4 CPUs), then rescore from the dump.

### Call localization

- `audio_id.onnx` also outputs `frames`: the second attention block's per-frame logits,
  [batch, species, 15] per 5 s window (1/3 s each; checked by planting a call at known
  offsets). `AudioBirdId.timeline` averages them over the last 16 runs into 1/3 s bins, and
  `findCall` (`audioIdSession.ts`) picks the call's span, saved as the clip's `call`. On the 62
  labeled 15 s clips it found a span in all 42 right ones, 2 s at the median (vs the 5 s
  window). No ground truth for spans yet: user trims before making an observation would be one.

### Activity gate for battery (not shipped)

- Idea: run the model every 1 s only while the 5 s window has sound above the background, every
  few seconds otherwise. `scripts/bird_audio/eval_gate.py` replays the live spectrogram's noise
  tracker (`ABSpectrogramColumn`) over the 323 labeled clips (154 right, 83 wrong reported at
  0.5) and checks whether each detection's window would still have been run.
- No setting works. Thresholds that lose no right detection (10 dB above the floor in 1-3
  bins) find 0% of 1 s steps quiet, so they save nothing; single-bin fluctuations always clear
  them. Requiring the sound to last 3-8 columns (~40-100 ms) helps little: 2% quiet costs 4-18
  right detections, 36% quiet costs 77. Every setting drops right detections much faster than
  wrong ones: many right calls are faint, while false positives are mostly loud.
- Quiet shares are a floor (clips only exist around detections), but a gate that drops right
  detections at any savings fails the "no right lost" rule regardless.
- Audio ID's power use goes down instead by running the model on CoreML / the Neural Engine
  (`-checkCoreML` in AudioBirdId.m, chosen per build after comparing against the CPU; look for
  "model provider" in the app log).

### Model size (int8 head weights, shipped)

- The per-species heads (`att_block*`, `head.`) are 76M of the 105M weights. Storing them
  as int8 per species (`scripts/onnx_weights.py`, called by `build_model.py`) took the
  weights from 210 to 135 MB with no detection change at 0.5 on 400 recordings or 327
  field clips; the geomodel went to int8 too (14 to 7.4 MB, no detection change).
- Not shipped: int8 on the encoder as well (scores moved up to 0.18 on field clips, -3/+1
  detections) and int4 heads (-9/+4). ORT folds the int8 weights back to fp16 at load
  (`session.disable_quant_qdq` in `AudioBirdId.m`), so CoreML and power use see the same
  graph; the cost is ~0.4 s more session load and ~100 MB more peak memory while loading.
  Cast/Mul nodes instead of DequantizeLinear needed no setting but peaked ~370 MB higher.
- eval_clips.py / eval_regions.py sessions don't set that entry, so ORT dequantizes per run
  there: same scores, just slower.
- The model returns NaN for every species on clipped input (samples at or beyond +/-1.0;
  6 of 3,255 windows, from 2 recordings), quantized or not. `isHeard` is false for NaN, so it
  only blanks those windows, but clamping the input to [-1, 1] before the run may fix it.
