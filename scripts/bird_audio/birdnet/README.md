# Audio ID models (BirdNET v3.0)

Within 100 km of Seattle Audio ID runs the bundled Seattle model below.
Elsewhere it downloads BirdNET's model for the region (~75 MB, or the 279 MB
worldwide model where no region applies) from a pinned revision of
https://huggingface.co/tphakala/BirdNET-v3.0-Models. Everywhere, species that
the bundled BirdNET geomodel (`audio_geo.onnx`, V3.0.3, from
https://huggingface.co/sammlapp/BirdNET_GeoModel) scores below 0.03 for the
user's place and week are left out. Model outputs are matched by scientific name
to iNaturalist species with research-grade sound observations, birds and other
animals alike (`export_catalog.py` -> `audioIdCatalog.json`).

## Seattle model

The Audio ID screen runs **BirdNET+ V3.0 developer preview 3.1**
(K. Lisa Yang Center for Conservation Bioacoustics, Cornell University;
Chemnitz University of Technology; Museum für Naturkunde Berlin), "Powered by
BirdNET", licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/),
using the North America (West) fp16 ONNX export from
https://huggingface.co/tphakala/BirdNET-v3.0-Models. Changes: the classifier
heads are sliced to the 229 species below, and for the 189 of them with
training data each score is averaged with a linear head on BirdNET's
embedding, trained on older iNaturalist recordings (`head_birdnet.py`); the result,
`ios/iNaturalistReactNative/audio_birds.onnx`, is under the same license.
Poaching and military use are prohibited by BirdNET's terms of use.

Rebuild (run in a scratch directory holding the BirdNET v3.0 NA-west fp32/fp16
models and labels):

    python3 seattle_species.py     # iNat bird species near Seattle
    python3 select_species.py      # ones BirdNET knows -> keep_idx.json
    python3 fetch_sets.py                  # eval + training recordings
    python3 score.py eval && python3 score.py train   # needs the NA-west fp32 model and Perch v2
    python3 head_birdnet.py <fp16.onnx> audio_birds.onnx
    python3 export_birdnet.py <repo>
    python3 export_catalog.py <repo>       # species table, regional models, geomodel
    python3 eval_regions.py <repo>         # small check outside Seattle -> report_regions.json
    python3 analyze.py                     # precision/recall of each lever -> report_levers.json

Held-out results are in `report_birdnet.json`.

## What improved precision and recall (`analyze.py`, `report_levers.json`)

On the 2,951 held-out recordings, at the app's threshold of 0.3, the head
raises recall from 0.944 to 0.953, and lowers other species flagged per recording
from 1.20 to 0.95; average precision rises from 0.786 to 0.866, and holds for
observers absent from the training set (0.823 -> 0.883). A geomodel
location/season filter, per-species thresholds, requiring 2-3 consecutive
windows, and Perch v2 (alone or ensembled) did no better than moving the global
threshold.
