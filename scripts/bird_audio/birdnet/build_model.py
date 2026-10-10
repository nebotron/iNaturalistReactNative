# Builds Audio ID's bundled, offline model and species table:
#  - BirdNET v3.0 (full, fp16, from a pinned revision of
#    tphakala/BirdNET-v3.0-Models) with its per-class tensors sliced to the
#    species iNaturalist has research-grade sound observations of, matched by
#    scientific name. Weights go in ios/iNaturalistReactNative/audio_id.data<N>
#    files under 95 MB each (GitHub's limit is 100 MB) next to audio_id.onnx;
#    the Xcode project bundles audio_id.data0-2, so update it if the count changes.
#  - src/components/AudioId/audioIdSpecies.json: [scientific name, common name,
#    taxon ID, geomodel index or -1] per model output. Only birds get a geomodel
#    index: it dropped the true species for 17% of insect and 3% of frog
#    recordings (eval_regions.py).
#  - ios/iNaturalistReactNative/audio_geo.onnx: the BirdNET geomodel.
# Usage (from this directory): python3 build_model.py <repo root>
import glob, json, os, shutil, sys, time, urllib.request
import numpy as np, onnx
from onnx import numpy_helper
from onnx.external_data_helper import set_external_data
from huggingface_hub import hf_hub_download
repo = sys.argv[1]; ios = f"{repo}/ios/iNaturalistReactNative"
HF, REV = "tphakala/BirdNET-v3.0-Models", "71e1ffb06c0323a3428536ac02f4ecc59742c4d6"
GEO, GEO_FILE = "sammlapp/BirdNET_GeoModel", "BirdNET+_Geomodel_V3.0.3_Global_12K"
CHUNK = 95_000_000

if not os.path.exists("inat_sound_species.json"):  # ~25 requests
    out = []
    for p in range(1, 30):
        r = json.loads(urllib.request.urlopen(
            "https://api.inaturalist.org/v1/observations/species_counts?sounds=true&quality_grade=research"
            f"&per_page=500&page={p}&locale=en", timeout=120).read())["results"]
        if not r: break
        out += [dict(id=x["taxon"]["id"], name=x["taxon"]["name"], common=x["taxon"].get("preferred_common_name"),
                     iconic=x["taxon"].get("iconic_taxon_name")) for x in r]
        time.sleep(1.5)
    json.dump(out, open("inat_sound_species.json", "w"))
inat = {s["name"]: s for s in json.load(open("inat_sound_species.json"))}
labels = [l.strip().split("_", 1) for l in open(hf_hub_download(HF, "full/birdnet-v3.0-preview3.1-labels-b1.txt", revision=REV))]
geo = {l.split("\t")[1]: i for i, l in enumerate(open(hf_hub_download(GEO, f"{GEO_FILE}_Labels.txt")))}
shutil.copyfile(hf_hub_download(GEO, f"{GEO_FILE}_FP16.onnx"), f"{ios}/audio_geo.onnx")

idx, species = [], []
for i, (name, common) in enumerate(labels):
    s = inat.get(name)
    if not s: continue
    idx.append(i)
    species.append([name, s["common"] or common, s["id"], geo.get(name, -1) if s["iconic"] == "Aves" else -1])
json.dump(species, open(f"{repo}/src/components/AudioId/audioIdSpecies.json", "w"), separators=(",", ":"))

m = onnx.load(hf_hub_download(HF, "full/birdnet-v3.0-preview3.1-fp16-b1.onnx", revision=REV)); g = m.graph
N = g.output[0].type.tensor_type.shape.dim[1].dim_value; idx = np.array(idx)
for i, t in enumerate(g.initializer):  # per-class tensors: attention/classification convs, linear head
    a = numpy_helper.to_array(t)
    if a.ndim and a.shape[0] == N and t.name.startswith(("att_block", "head.")):
        g.initializer[i].CopyFrom(numpy_helper.from_array(a[idx], t.name))
del g.value_info[:]
g.output[0].type.tensor_type.shape.dim[1].dim_value = len(idx)
for o in list(g.output[1:]): g.output.remove(o)
for f in glob.glob(f"{ios}/audio_id.data*"): os.remove(f)
n, f, off = 0, None, 0
for t in g.initializer:
    if len(t.raw_data) < 4096: continue
    if f is None or off + len(t.raw_data) > CHUNK:
        if f: f.close()
        name = f"audio_id.data{n}"; f = open(f"{ios}/{name}", "wb"); n += 1; off = 0
    data = t.raw_data; f.write(data); set_external_data(t, name, off, len(data)); t.ClearField("raw_data")
    t.data_location = onnx.TensorProto.EXTERNAL; off += len(data)
f.close()
onnx.save(m, f"{ios}/audio_id.onnx")
print(len(species), "species,", n, "weight files")
