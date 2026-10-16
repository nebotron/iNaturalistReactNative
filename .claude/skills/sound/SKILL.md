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

### Session 4 (184 labels: 75 right, 109 wrong; 24 now carry location, all Seattle)

- Since the 0.5 threshold (34ec957): 22 right, 2 wrong (Clark's Nutcracker, Red Fox).
  With logged ≥ 0.5 over all labels: 70 right, 38 wrong.
- **Shipped**: iNaturalist nearby filter (`fetchNearbyTaxa`, applied to scores in
  `onScores`). Species need ≥ 2e-5 × the area's verifiable observations within 25 km;
  areas under 100k aren't filtered (rural Wyoming has 2 species with ≥ 20). The geomodel
  passes Blue Jay (0.056), Nutcracker (0.055), Red Fox (0.099) at Seattle; iNat has 0–5
  observations within 25 km. Field (≥ 0.5): 70/38 → 70/24. Recall on the 700
  `eval_regions.py` recordings (counts with `id_below` the recording): 99.3% keep the
  true species; a fixed count of 20 kept only 89% (insects, eastern Australia).
  Unlocated labels were assumed to be Seattle (the located ones all are).
- Speech is the main noise source: YAMNet's top class was Speech on 59 of 97 wrong clips
  vs 8 of 71 right; Harbor Seal / Red Fox detections are mostly people talking. A gate on
  mean YAMNet speech (classes 0–4) < 0.4 over the clip: 62/35 → 62/27 (logged ≥ 0.5,
  clips only); < 0.3 → 60/21 (loses 2 crows talked over). With the nearby filter: 70/20.
  Not shipped: needs YAMNet in the app (4 MB tflite; app runs ONNX), and many seal/fox
  clips predate 3d4ee64 so they lag the scored window. Worth doing if wrong seals persist.
- BirdNET v3 has no noise / human classes (unlike v2.4); its "Animalia" class is always 0.
- Retraining: a linear speech probe on BirdNET's 1280-d embeddings (full model's second
  output), YAMNet as teacher, 1,559 windows of 599 iNat recordings: held-out AUC 0.78,
  0.82 on field clips; every cutoff dropped right detections. Not useful at this data
  size; would need a real speech set (e.g. LibriSpeech) mixed with outdoor audio.
- The fp16 model returns NaN on clipped input (−1 to 0 dBFS; e.g. 18 of 1,777 windows,
  the two Trumpeter Swan clips), so such windows report nothing.
- Repro scripts were ad hoc (scratchpad); the recall check is
  `observations?verifiable=true&taxon_id=T&lat&lng&radius=25&id_below=<obs id>`.
