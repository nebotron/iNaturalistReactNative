# Small check of Audio ID outside Seattle, run the way the app runs it: the
# model picked for each recording's location from audioIdCatalog.json, scores
# kept only for species the geomodel puts at that place and week, threshold 0.3.
# A few recent research-grade sound observations per set (~70 each).
# Usage (from this directory): python3 eval_regions.py <repo root>
import json, math, os, subprocess, sys, time, urllib.request
import numpy as np, onnxruntime as ort, imageio_ffmpeg
from huggingface_hub import hf_hub_download
repo = sys.argv[1]; FF = imageio_ffmpeg.get_ffmpeg_exe(); TH = 0.3; GEO_TH = 0.03
cat = json.load(open(f"{repo}/src/components/AudioId/audioIdCatalog.json"))
rev = cat["baseUrl"].split("/resolve/")[1].strip("/")
row = {s[2]: i for i, s in enumerate(cat["species"])}
SETS = {  # name: (iconic taxon, swlat, swlng, nelat, nelng)
    "birds, eastern US": ("Aves", 38, -80, 45, -70), "birds, Britain": ("Aves", 50, -6, 56, 2),
    "frogs, eastern US": ("Amphibia", 30, -90, 45, -70), "insects, eastern US": ("Insecta", 30, -90, 45, -70),
    "birds, eastern Australia": ("Aves", -38, 145, -26, 154)}

def pick(lat, lng):  # same rule as AudioId.tsx
    m = cat["models"]; s = m["seattle"]
    if km(lat, lng, *s["center"]) <= s["radiusKm"]: return "seattle"
    inside = [(v["tier"], -min((b[1] - b[0]) * (b[3] - b[2]) for b in v["bboxes"]), k) for k, v in m.items()
              if "bboxes" in v and any(b[0] <= lat <= b[1] and b[2] <= lng <= b[3] for b in v["bboxes"])]
    return max(inside)[2] if inside else "global"
def km(a, b, c, d):
    p = math.pi / 180
    return 12742 * math.asin(math.sqrt(math.sin((c - a) * p / 2) ** 2
                                       + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2))
def week(d):
    y, mo, da = map(int, d.split("-")); return (mo - 1) * 4 + min(4, (da - 1) // 7 + 1)

os.makedirs("raw_regions", exist_ok=True); recs = []
for name, (iconic, s, w, n, e) in SETS.items():
    d = json.loads(urllib.request.urlopen(
        f"https://api.inaturalist.org/v1/observations?sounds=true&quality_grade=research&iconic_taxa={iconic}"
        f"&swlat={s}&swlng={w}&nelat={n}&nelng={e}&created_d1=2025-09-01&rank=species&per_page=70"
        "&order_by=id", timeout=120).read())["results"]
    for o in d:
        f = [x for x in o["sounds"] if x.get("file_url")]
        if not f or not o.get("location") or not o.get("observed_on"): continue
        p = f"raw_regions/{o['id']}"
        if not os.path.exists(p): open(p, "wb").write(urllib.request.urlopen(f[0]["file_url"], timeout=120).read())
        lat, lng = map(float, o["location"].split(","))
        recs.append(dict(set=name, path=p, taxon=o["taxon"]["id"], lat=lat, lng=lng, week=week(o["observed_on"])))
    time.sleep(1)
print(len(recs), "recordings", flush=True)

geo = ort.InferenceSession(f"{repo}/ios/iNaturalistReactNative/audio_geo.onnx"); sessions = {}
def session(k):
    if k not in sessions:
        f = f"{repo}/ios/iNaturalistReactNative/audio_birds.onnx" if k == "seattle" else hf_hub_download(
            "tphakala/BirdNET-v3.0-Models", cat["models"][k]["file"], revision=rev)
        sessions[k] = ort.InferenceSession(f)
    return sessions[k]
res = {}
for r in recs:
    k = pick(r["lat"], r["lng"]); sp = np.array(cat["models"][k]["species"])
    y = np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", r["path"], "-t", "30", "-ac", "1", "-ar", "32000",
                                      "-f", "f32le", "-"], capture_output=True).stdout, np.float32)
    if len(y) < 16000: continue
    y = np.concatenate([np.zeros(128000, np.float32), y, np.zeros(128000, np.float32)])
    X = np.stack([y[j:j + 160000] for j in range(0, len(y) - 160000 + 1, 32000)])
    S = session(k).run(["output"], {"input": X})[0].max(0)
    g = geo.run(None, {"input": np.array([[r["lat"], r["lng"], r["week"]]], np.float32)})[0][0]
    gi = np.array([cat["species"][i][3] if i >= 0 else -1 for i in sp])
    ok = (sp >= 0) & ((gi < 0) | (g[np.maximum(gi, 0)] >= GEO_TH))
    t = row.get(r["taxon"], -2); covered = t in set(sp[ok]); has = t in set(sp)
    for variant, mask in (("no geo filter", sp >= 0), ("geo filter", ok)):
        det = set(sp[mask & (S >= TH)]); top = sp[mask][np.argmax(S[mask])] if mask.any() else -1
        res.setdefault((r["set"], variant), []).append(dict(model=k, inmodel=has, covered=covered and variant == "geo filter" or has and variant != "geo filter",
                                                           tp=t in det, fp=len(det - {t}), top1=top == t))
out = {}
for (s, v), L in sorted(res.items()):
    n = len(L); tp = sum(x["tp"] for x in L); fp = sum(x["fp"] for x in L)
    out[f"{s} / {v}"] = dict(n=n, models=sorted({x["model"] for x in L}), species_in_model=round(sum(x["inmodel"] for x in L) / n, 3),
                             species_kept=round(sum(x["covered"] for x in L) / n, 3), recall=round(tp / n, 3),
                             precision=round(tp / max(1, tp + fp), 3), fp_per_rec=round(fp / n, 2), top1=round(sum(x["top1"] for x in L) / n, 3))
    print(f"{s:26s} {v:14s}", out[f"{s} / {v}"], flush=True)
json.dump(out, open("report_regions.json", "w"), indent=1)
