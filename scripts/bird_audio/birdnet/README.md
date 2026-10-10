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
drops birds unlikely at the user's place and week when location is available.
Everything runs on device with no network. Poaching and military use are
prohibited by BirdNET's terms of use.

Rebuild and check (from this directory):

    python3 build_model.py <repo>     # model, data files, geomodel, audioIdSpecies.json
    python3 eval_regions.py <repo>    # small accuracy check -> report_regions.json

## Accuracy (`report_regions.json`)

70 recent research-grade recordings per set, run as the app runs: 5 s windows
every second, threshold 0.3, with the geomodel filter (birds only). The filter
never dropped a true species here; without it, wrong species per recording rise
by 10-35% for birds.

| set | recall | precision | other species / rec. | top-1 |
|---|---|---|---|---|
| birds, Seattle area | 0.957 | 0.554 | 0.77 | 0.900 |
| birds, eastern US | 0.986 | 0.527 | 0.89 | 0.943 |
| birds, Britain | 0.929 | 0.481 | 1.00 | 0.857 |
| birds, eastern Australia | 0.957 | 0.419 | 1.33 | 0.757 |
| frogs, eastern US | 0.900 | 0.529 | 0.80 | 0.729 |
| insects, eastern US | 0.743 | 0.627 | 0.44 | 0.671 |
