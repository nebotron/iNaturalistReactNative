---
name: sound
description: Download labeled Audio ID clips, evaluate accuracy, and explore ways to improve it.
---

Run `python3 scripts/bird_audio/eval_clips.py` (needs `pip install numpy onnxruntime` and
`ffmpeg`). It downloads every Audio ID label and clip from Firebase, reports the labeled
precision, re-runs `ios/iNaturalistReactNative/audio_id.onnx` on each clip and shows how many
right and wrong detections each scoring variant would still report. Report the current
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
  species at ≥ 0.3 (`THRESHOLD` in `audioIdSession.ts`).

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
- Not shipped, for the user to decide: bird threshold 0.5. Field: right 20 → 18, wrong 23 → 8.
  Recordings: bird recall 0.949 → 0.937, wrong birds per recording 0.74 → 0.57 (0.4: 0.943,
  0.65; field drops 1 right, 5 wrong). A non-bird threshold of 0.5 (no boost) would leave 10 of
  74 wrong for recall 0.706; 0.7 leaves 3.
- To sweep thresholds offline, dump per-window scores and geomodel values for the
  `eval_regions.py` recordings once (~45 min on 4 CPUs), then rescore from the dump.
