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
