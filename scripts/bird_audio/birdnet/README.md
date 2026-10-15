# Audio ID model (BirdNET v3.0, worldwide, offline)

Audio ID runs **BirdNET+ V3.0 developer preview 3.1** (K. Lisa Yang Center for
Conservation Bioacoustics, Cornell University; Chemnitz University of
Technology; Museum für Naturkunde Berlin), "Powered by BirdNET", licensed
CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/), from the full
fp16 ONNX export at https://huggingface.co/tphakala/BirdNET-v3.0-Models.
Changes: the classifier heads are sliced to the 7,994 species that iNaturalist
has research-grade sound observations of (birds, frogs, insects, mammals), and
the weights are split across `audio_id.data0-2` to stay under GitHub's file size
limit. The result, `ios/iNaturalistReactNative/audio_id.onnx` and its data
files, is under the same license. The bundled BirdNET geomodel
(`audio_geo.onnx`, V3.0.3, https://huggingface.co/sammlapp/BirdNET_GeoModel)
drops species unlikely at the user's place and week when location is available.
Everything runs on device with no network. Poaching and military use are
prohibited by BirdNET's terms of use.

Rebuild and check (from this directory):

    python3 build_model.py <repo>     # model, data files, geomodel, audioIdSpecies.json
    python3 eval_regions.py <repo>    # small accuracy check -> report_regions.json

## Accuracy (`report_regions.json`)

Run as the app runs: 5 s windows every second, the geomodel filter, and a
species counts as heard in a window when it scores 0.3+ and is the window's
top species or scores 0.7+. On the same 923 recordings (600 from
the Seattle area, 323 from the sets below), that top-species rule cut wrong
species per recording from 1.17 to 0.83 (Seattle) and 0.86 to 0.65 (others)
while recall went from 0.927 to 0.925 and 0.920 to 0.916. Raising the
threshold, stricter geomodel cutoffs, a score ratio to the top species, and
requiring consecutive windows all lost more recall for less gain.

| set | n | recall | precision | other species / rec. | top-1 |
|---|---|---|---|---|---|
| Seattle eval sample (before weighting) | 600 | 0.925 | 0.528 | 0.83 | 0.810 |
| birds, Seattle area | 70 | 0.986 | 0.645 | 0.54 | 0.914 |
| birds, California | 70 | 0.886 | 0.449 | 1.09 | 0.700 |
| birds, eastern US | 70 | 0.957 | 0.626 | 0.57 | 0.800 |
| birds, Britain | 70 | 0.971 | 0.660 | 0.50 | 0.857 |
| birds, eastern Australia | 70 | 0.971 | 0.459 | 1.14 | 0.900 |
| frogs, eastern US | 70 | 0.943 | 0.617 | 0.59 | 0.843 |
| frogs, western US | 70 | 0.543 | 0.521 | 0.50 | 0.486 |
| insects, eastern US | 70 | 0.829 | 0.699 | 0.36 | 0.814 |
| insects, Europe | 70 | 0.700 | 0.653 | 0.37 | 0.700 |
| mammals, North America | 70 | 0.857 | 0.645 | 0.47 | 0.843 |

Recordings carry one label, so some "other species" are real background
animals; the geomodel filter dropped the true species for 3 recordings, all
non-bird (2 eastern US insects, 1 western US frog).

Non-birds score lower in the geomodel (Hoary Marmot at Mount Rainier is
0.01-0.03), so they use a 0.0003 cutoff, which still drops species from the
wrong region (Chimpanzee there is 0.0). On 560 recordings of mammals, frogs and
insects (North America, Europe, eastern Australia), it cut wrong non-bird
species per recording from 0.28 to 0.17 and lost 3 of 372 true detections (two
western US frogs the geomodel misplaces); 0.03 lost 15.

Non-bird audio odds are also multiplied by (geomodel score / 0.037) ^ 0.4, so
a sound that is common at the user's place and week needs less audio evidence.
Tuned on 900 recordings (March-August 2025) and checked on the 700 in the
table (from September 2025), it raised non-bird recall from 0.751 to 0.774 and
cut their wrong species per recording from 0.46 to 0.45; bird recordings were
unchanged (0.77 to 0.78 wrong species). The same weighting for birds did no
better than raising their threshold.
