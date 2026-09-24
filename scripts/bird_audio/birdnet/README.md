# Audio ID model (BirdNET v3.0, Seattle species)

The Audio ID screen runs **BirdNET+ V3.0 developer preview 3.1**
(K. Lisa Yang Center for Conservation Bioacoustics, Cornell University;
Chemnitz University of Technology; Museum für Naturkunde Berlin), "Powered by
BirdNET", licensed CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/),
using the North America (West) fp16 ONNX export from
https://huggingface.co/tphakala/BirdNET-v3.0-Models. Changes: the classifier
heads are sliced to the 229 species below; the result,
`ios/iNaturalistReactNative/audio_birds.onnx`, is under the same license.
Poaching and military use are prohibited by BirdNET's terms of use.

Rebuild (run in a scratch directory holding the BirdNET v3.0 NA-west fp32/fp16
models and labels):

    python3 seattle_species.py     # iNat bird species near Seattle
    python3 select_species.py      # ones BirdNET knows -> keep_idx.json
    python3 slice_birdnet.py <fp16.onnx> audio_birds.onnx keep_idx.json
    python3 export_birdnet.py <repo>
    python3 fetch_eval.py && python3 evalbn.py && python3 eval_app.py   # accuracy

Held-out results are in `report_birdnet.json`.
