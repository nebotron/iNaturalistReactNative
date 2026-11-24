# Score eval_regions.py's sets (plus southern California birds and California
# mammals) as the app runs now: 5 s windows every 2.5 s, input clamped to
# [-1, 1]. Saves each recording's max score per species (max.npy), its
# geomodel vector (geo.npy) and metadata (meta.json), so thresholds and geo
# cutoffs can be swept offline in seconds. ~25 min on 4 CPUs.
# Usage: python3 dump_regions.py <repo root> <outdir>
import json, os, subprocess, sys, time, urllib.request
import numpy as np, onnxruntime as ort, imageio_ffmpeg
from concurrent.futures import ThreadPoolExecutor
repo, out = sys.argv[1], sys.argv[2]; ios = f"{repo}/ios/iNaturalistReactNative"
FF = imageio_ffmpeg.get_ffmpeg_exe()
SETS = {
    "birds, Seattle area": ("Aves", 47, -123, 48.2, -121.6),
    "birds, eastern US": ("Aves", 38, -80, 45, -70), "birds, Britain": ("Aves", 50, -6, 56, 2),
    "frogs, eastern US": ("Amphibia", 30, -90, 45, -70), "insects, eastern US": ("Insecta", 30, -90, 45, -70),
    "birds, eastern Australia": ("Aves", -38, 145, -26, 154), "birds, California": ("Aves", 32.5, -122, 38.5, -116),
    "mammals, North America": ("Mammalia", 25, -125, 55, -65), "frogs, western US": ("Amphibia", 32, -125, 49, -110),
    "insects, Europe": ("Insecta", 40, -5, 55, 20),
    # extra: where the field false positives are
    "birds, southern California": ("Aves", 33.5, -119.5, 34.6, -117.5),
    "mammals, California": ("Mammalia", 32.5, -124, 42, -114),
}
def week(d):
    y, mo, da = map(int, d.split("-")); return (mo - 1) * 4 + min(4, (da - 1) // 7 + 1)
raw = os.path.join(out, "raw"); os.makedirs(raw, exist_ok=True); recs = []
for name, (iconic, s, w, n, e) in SETS.items():
    d = json.loads(urllib.request.urlopen(
        f"https://api.inaturalist.org/v1/observations?sounds=true&quality_grade=research&iconic_taxa={iconic}"
        f"&swlat={s}&swlng={w}&nelat={n}&nelng={e}&created_d1=2025-09-01&rank=species&per_page=70"
        "&order_by=id", timeout=120).read())["results"]
    for o in d:
        f = [x for x in o["sounds"] if x.get("file_url")]
        if not f or not o.get("location") or not o.get("observed_on"): continue
        lat, lng = map(float, o["location"].split(","))
        recs.append(dict(set=name, id=o["id"], url=f[0]["file_url"], taxon=o["taxon"]["id"],
                         lat=lat, lng=lng, week=week(o["observed_on"])))
    time.sleep(1)
def fetch(r):
    p = f"{raw}/{r['id']}"
    if not os.path.exists(p):
        try: open(p, "wb").write(urllib.request.urlopen(r["url"], timeout=120).read())
        except Exception as ex: print("fail", r["id"], ex, flush=True)
with ThreadPoolExecutor(8) as pool: list(pool.map(fetch, recs))
print(len(recs), "recordings", flush=True)
opts = ort.SessionOptions(); opts.intra_op_num_threads = 4
model = ort.InferenceSession(f"{ios}/audio_id.onnx", opts); geo = ort.InferenceSession(f"{ios}/audio_geo.onnx")
meta, MX, G = [], [], []
for i, r in enumerate(recs):
    p = f"{raw}/{r['id']}"
    if not os.path.exists(p): continue
    y = np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", p, "-t", "30", "-ac", "1", "-ar", "32000",
                                      "-f", "f32le", "-"], capture_output=True).stdout, np.float32)
    if len(y) < 16000: continue
    y = np.clip(np.concatenate([np.zeros(80000, np.float32), y, np.zeros(80000, np.float32)]), -1, 1)
    X = np.stack([y[j:j + 160000] for j in range(0, len(y) - 160000 + 1, 80000)])
    S = np.concatenate([model.run(["output"], {"input": X[b:b + 1]})[0] for b in range(len(X))])
    MX.append(np.nan_to_num(S).max(0).astype(np.float16))
    G.append(geo.run(None, {"input": np.array([[r["lat"], r["lng"], r["week"]]], np.float32)})[0][0].astype(np.float16))
    meta.append(r)
    if i % 50 == 0: print(i, flush=True)
np.save(f"{out}/max.npy", np.stack(MX)); np.save(f"{out}/geo.npy", np.stack(G))
json.dump(meta, open(f"{out}/meta.json", "w"))
print("done", len(meta), flush=True)
