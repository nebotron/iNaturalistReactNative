# Writes src/components/AudioId/audioIdCatalog.json: which model Audio ID runs
# where, and which iNaturalist species each model output is.
#  - "seattle": the bundled audio_birds.onnx (BirdNET + head, 229 species).
#  - one entry per BirdNET v3.0 regional model (~75 MB fp16, downloaded by the
#    app on first use from a pinned revision of tphakala/BirdNET-v3.0-Models).
#  - "global": the full model (279 MB) for places no region covers.
# BirdNET outputs are matched to iNaturalist species with research-grade sound
# observations by scientific name (unmatched outputs are ignored), and birds to
# the BirdNET geomodel, which the app uses to drop birds unlikely at the user's
# place and week (it dropped 17% of true species for insects, 3% for frogs). Also copies the fp16 geomodel into the iOS bundle.
# Usage (from this directory): python3 export_catalog.py <repo root>
import json, os, shutil, sys, time, urllib.request
from huggingface_hub import HfApi, hf_hub_download
repo = sys.argv[1]; HF = "tphakala/BirdNET-v3.0-Models"; GEO = "sammlapp/BirdNET_GeoModel"
GEO_FILE = "BirdNET+_Geomodel_V3.0.3_Global_12K"
SYN = {"Leuconotopicus villosus": "Dryobates villosus", "Hesperiphona vespertina": "Coccothraustes vespertinus",
       "Vireo swainsoni": "Vireo gilvus", "Setophaga aestiva": "Setophaga petechia",
       "Numenius hudsonicus": "Numenius phaeopus"}

info = HfApi().model_info(HF, files_metadata=True); rev = info.sha
size = {s.rfilename: s.size for s in info.siblings}
get = lambda f, r=HF, v=rev: hf_hub_download(r, f, revision=v)
regions = json.load(open(get("regions.json")))["regions"]
sha = dict(reversed(l.split()) for l in open(get("SHA256SUMS")) if l.strip())
labels = [l.strip().split("_", 1) for l in open(get("full/birdnet-v3.0-preview3.1-labels-b1.txt"))]
geo = {l.split("\t")[1]: i for i, l in enumerate(open(get(f"{GEO_FILE}_Labels.txt", GEO, None)))}
shutil.copy(get(f"{GEO_FILE}_FP16.onnx", GEO, None), f"{repo}/ios/iNaturalistReactNative/audio_geo.onnx")

if not os.path.exists("inat_sound_species.json"):  # ~25 requests
    out = []
    for p in range(1, 30):
        r = json.loads(urllib.request.urlopen(
            "https://api.inaturalist.org/v1/observations/species_counts?sounds=true&quality_grade=research"
            f"&per_page=500&page={p}&locale=en", timeout=120).read())["results"]
        if not r: break
        out += [dict(id=x["taxon"]["id"], name=x["taxon"]["name"], common=x["taxon"].get("preferred_common_name"),
                     iconic=x["taxon"].get("iconic_taxon_name"))
                for x in r]
        time.sleep(1.5)
    json.dump(out, open("inat_sound_species.json", "w"))
inat = {s["name"]: s for s in json.load(open("inat_sound_species.json"))}

species, row = [], {}
def add(taxon_id, name, common, bn_name, bird=True):
    if taxon_id not in row:
        g = geo.get(bn_name, geo.get(name, -1)) if bird else -1
        row[taxon_id] = len(species); species.append([name, common or name, taxon_id, g])
    return row[taxon_id]
def by_full_index(i):
    name, common = labels[i]; s = inat.get(name)
    return add(s["id"], name, s["common"] or common, name, s.get("iconic") == "Aves") if s else -1

keep = json.load(open("keep_species.json"))
models = {"seattle": dict(name="Seattle area", center=[47.61, -122.33], radiusKm=100, species=[
    add(s["id"], s["name"], s["common"], SYN.get(s["name"], s["name"])) for s in keep])}
for key, r in regions.items():
    f = f"regional/{key}/birdnet-v3.0-preview3.1-{key}-fp16-b1.onnx"
    idx = [int(l) for l in open(get(f"regional/{key}/birdnet-v3.0-preview3.1-{key}-indices-b1.txt")) if l.strip()]
    models[key] = dict(name=r["name"], tier=r["tier"], bboxes=r["bboxes"], file=f, sha256=sha[f],
                       sizeMb=round(size[f] / 1e6), species=[by_full_index(i) for i in idx])
f = "full/birdnet-v3.0-preview3.1-fp16-b1.onnx"
models["global"] = dict(name="Worldwide", file=f, sha256=sha[f], sizeMb=round(size[f] / 1e6),
                        species=[by_full_index(i) for i in range(len(labels))])
json.dump(dict(baseUrl=f"https://huggingface.co/{HF}/resolve/{rev}/", species=species, models=models),
          open(f"{repo}/src/components/AudioId/audioIdCatalog.json", "w"), separators=(",", ":"))
print(len(species), "species;", {k: sum(i >= 0 for i in m["species"]) for k, m in models.items()})
