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
| Seattle eval sample | 600 | 0.925 | 0.528 | 0.83 | 0.810 |
| birds, Seattle area | 68 | 0.985 | 0.663 | 0.50 | 0.912 |
| birds, eastern US | 20 | 0.950 | 0.543 | 0.80 | 0.900 |
| birds, Britain | 60 | 0.950 | 0.594 | 0.65 | 0.833 |
| birds, eastern Australia | 50 | 0.960 | 0.471 | 1.08 | 0.760 |
| frogs, eastern US | 63 | 0.921 | 0.552 | 0.75 | 0.714 |
| insects, eastern US | 62 | 0.758 | 0.691 | 0.34 | 0.710 |

Recordings carry one label, so some "other species" are real background
animals; the geomodel filter never dropped a true species here.

Non-birds score lower in the geomodel (Hoary Marmot at Mount Rainier is
0.01-0.03), so they use a 0.0003 cutoff, which still drops species from the
wrong region (Chimpanzee there is 0.0). On 560 recordings of mammals, frogs and
insects (North America, Europe, eastern Australia), it cut wrong non-bird
species per recording from 0.28 to 0.17 and lost 3 of 372 true detections (two
western US frogs the geomodel misplaces); 0.03 lost 15.
