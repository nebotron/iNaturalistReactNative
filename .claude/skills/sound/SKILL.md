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
