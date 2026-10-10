# Small check of Audio ID run the way the app runs it: the bundled model on 5 s
# windows every second, threshold 0.3, with and without dropping birds the
# geomodel doesn't put at the recording's place and week. ~70 recent
# research-grade sound observations per set.
# Usage (from this directory): python3 eval_regions.py <repo root>
import json, os, subprocess, sys, time, urllib.request
import numpy as np, onnxruntime as ort, imageio_ffmpeg
repo = sys.argv[1]; ios = f"{repo}/ios/iNaturalistReactNative"
FF = imageio_ffmpeg.get_ffmpeg_exe(); TH = 0.3; GEO_TH = 0.03
species = json.load(open(f"{repo}/src/components/AudioId/audioIdSpecies.json"))
row = {s[2]: i for i, s in enumerate(species)}; gi = np.array([s[3] for s in species])
SETS = {  # name: (iconic taxon, swlat, swlng, nelat, nelng)
    "birds, Seattle area": ("Aves", 47, -123, 48.2, -121.6),
    "birds, eastern US": ("Aves", 38, -80, 45, -70), "birds, Britain": ("Aves", 50, -6, 56, 2),
    "frogs, eastern US": ("Amphibia", 30, -90, 45, -70), "insects, eastern US": ("Insecta", 30, -90, 45, -70),
    "birds, eastern Australia": ("Aves", -38, 145, -26, 154)}
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

model = ort.InferenceSession(f"{ios}/audio_id.onnx"); geo = ort.InferenceSession(f"{ios}/audio_geo.onnx")
res = {}
for r in recs:
    y = np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", r["path"], "-t", "30", "-ac", "1", "-ar", "32000",
                                      "-f", "f32le", "-"], capture_output=True).stdout, np.float32)
    if len(y) < 16000: continue
    y = np.concatenate([np.zeros(128000, np.float32), y, np.zeros(128000, np.float32)])
    X = np.stack([y[j:j + 160000] for j in range(0, len(y) - 160000 + 1, 32000)])
    S = np.concatenate([model.run(["output"], {"input": X[b:b + 8]})[0] for b in range(0, len(X), 8)]).max(0)
    g = geo.run(None, {"input": np.array([[r["lat"], r["lng"], r["week"]]], np.float32)})[0][0]
    keep = (gi < 0) | (g[np.maximum(gi, 0)] >= GEO_TH); t = row.get(r["taxon"], -1)
    for variant, mask in (("no geo filter", np.ones_like(keep)), ("geo filter", keep)):
        det = set(np.where(mask & (S >= TH))[0])
        res.setdefault((r["set"], variant), []).append(dict(
            known=t >= 0, kept=t >= 0 and bool(mask[t]), tp=t in det, fp=len(det - {t}),
            top1=t >= 0 and int(np.argmax(np.where(mask, S, -1))) == t))
out = {}
for (s, v), L in sorted(res.items()):
    n = len(L); tp = sum(x["tp"] for x in L); fp = sum(x["fp"] for x in L)
    out[f"{s} / {v}"] = dict(n=n, species_in_model=round(sum(x["known"] for x in L) / n, 3),
                             species_kept=round(sum(x["kept"] for x in L) / n, 3), recall=round(tp / n, 3),
                             precision=round(tp / max(1, tp + fp), 3), fp_per_rec=round(fp / n, 2),
                             top1=round(sum(x["top1"] for x in L) / n, 3))
    print(f"{s:26s} {v:14s}", out[f"{s} / {v}"], flush=True)
json.dump(out, open("report_regions.json", "w"), indent=1)
