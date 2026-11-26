# Builds src/components/AudioId/audioIdSplits.json: BirdNET species that
# iNaturalist has since split, so a detection can be given the daughter
# species found where the user is (audioIdModel.ts). build_model.py matches
# BirdNET's labels to iNaturalist by scientific name, and a split species keeps
# its name on one daughter, so without this table every Marsh Wren became an
# Eastern Marsh Wren.
#
# A species is listed when a committed iNaturalist split has it as input and a
# daughter species (still active, at species rank) that BirdNET doesn't have
# by name. Its candidates are the species itself, when still active, and those
# daughters. Each candidate gets up to 600 research-grade observation points,
# rounded to 0.5 degrees; `shared` is the candidates' nearest common ancestor,
# reported where they overlap or without a location.
#
# Run after build_model.py, from this directory: python3 build_splits.py <repo>
# Re-run when iNaturalist commits new splits; it prints what it lists.
import json, os, sys, time, urllib.request

repo = sys.argv[1]
REV = "71e1ffb06c0323a3428536ac02f4ecc59742c4d6"  # keep in step with build_model.py
LABELS = ("https://huggingface.co/tphakala/BirdNET-v3.0-Models/resolve/"
          f"{REV}/full/birdnet-v3.0-preview3.1-labels-b1.txt")
# Birds, amphibians, insects, mammals, reptiles, ray-finned fish, arachnids, molluscs
ICONIC = [3, 20978, 47158, 40151, 26036, 47178, 47119, 47115]
SINCE = "2019-01-01"

def get(url):
    for attempt in range(5):
        try:
            return json.loads(urllib.request.urlopen(url, timeout=120).read())
        except Exception:
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"failed: {url}")

def cached(path, build):
    if not os.path.exists(path):
        json.dump(build(), open(path, "w"))
    return json.load(open(path))

def fetch_splits():
    out = {}
    for iconic in ICONIC:
        for page in range(1, 1000):
            batch = get("https://www.inaturalist.org/taxon_changes.json?types[]=TaxonSplit"
                        f"&committed=Yes&per_page=30&iconic_taxon_id={iconic}&page={page}")
            for change in batch: out[change["id"]] = change
            if not batch or (batch[-1]["committed_on"] or "") < SINCE: break
            time.sleep(1)
    return list(out.values())

def fetch_taxa(ids):
    taxa = {}
    ids = sorted(set(ids))
    for i in range(0, len(ids), 30):
        for t in get("https://api.inaturalist.org/v1/taxa/"
                     + ",".join(map(str, ids[i:i + 30])) + "?locale=en")["results"]:
            taxa[t["id"]] = t
        time.sleep(1)
    return taxa

def fetch_points(taxon_id):
    cells = set()
    for page in range(1, 4):
        results = get("https://api.inaturalist.org/v1/observations?quality_grade=research"
                      f"&taxon_id={taxon_id}&per_page=200&page={page}&order_by=random")["results"]
        for r in results:
            if r.get("location"):
                lat, lng = map(float, r["location"].split(","))
                cells.add((round(lat * 2), round(lng * 2)))
        time.sleep(1)
        if len(results) < 200: break
    return [v for cell in sorted(cells) for v in cell]

species = json.load(open(f"{repo}/src/components/AudioId/audioIdSpecies.json"))
by_id = {s[2]: s for s in species}
birdnet = {line.split("_", 1)[0] for line in urllib.request.urlopen(LABELS).read().decode().splitlines()}
splits = cached("inat_splits.json", fetch_splits)

daughters = {}  # taxon ID in audioIdSpecies.json -> daughter IDs BirdNET lacks
for change in splits:
    for t in change["input_taxa"]:
        if t["id"] in by_id:
            daughters.setdefault(t["id"], set()).update(
                o["id"] for o in change["output_taxa"]
                if o["name"] not in birdnet and o["id"] != t["id"])
taxa = fetch_taxa([i for k, ds in daughters.items() for i in [k, *ds]])
# A daughter since renamed is followed to its current name
renamed = {i: t["current_synonymous_taxon_ids"][0] for i, t in taxa.items()
           if not t["is_active"] and len(t.get("current_synonymous_taxon_ids") or []) == 1}
taxa.update(fetch_taxa([i for i in renamed.values() if i not in taxa]))

def current(i):
    t = taxa.get(renamed.get(i, i))
    return t if t and t["is_active"] and t["rank"] == "species" else None

table = {}
for parent_id, ds in sorted(daughters.items(), key=lambda kv: by_id[kv[0]][0]):
    name = by_id[parent_id][0]
    kids = [t for t in map(current, ds)
            if t and t["name"] not in birdnet and t["id"] != parent_id]
    if not kids: continue
    parent = taxa[parent_id]
    candidates = ([parent] if parent["is_active"] else []) + kids
    candidates = list({t["id"]: t for t in candidates}.values())
    common = [a for a in candidates[0]["ancestor_ids"]
              if all(a in t["ancestor_ids"] for t in candidates) and a not in {t["id"] for t in candidates}]
    shared = fetch_taxa([common[-1]])[common[-1]]
    table[name] = {
        "shared": [shared["id"], shared["name"], shared.get("preferred_common_name") or shared["name"]],
        "taxa": [[t["id"], t["name"], t.get("preferred_common_name") or t["name"], fetch_points(t["id"])]
                 for t in candidates],
    }
    print(f"{name}: {' / '.join(t['name'] for t in candidates)}; shared {shared['name']}")
json.dump(table, open(f"{repo}/src/components/AudioId/audioIdSplits.json", "w"), separators=(",", ":"))
print(len(table), "split species")
