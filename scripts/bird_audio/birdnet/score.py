# Per-window scores and embeddings for every recording in <set>_meta.json.
# Audio is streamed the way the app sees it: 32 kHz mono, first 30 s, padded with
# 4 s of silence on each side, 5 s windows every HOP s.
#   BirdNET v3.0 NA-west fp32 (same weights as audio_birds.onnx, unsliced): 229 Seattle
#   species probabilities + 1280-d embedding.  Perch v2: 229 logits + 1536-d embedding.
import json, os, sys, subprocess, numpy as np, onnxruntime as ort, imageio_ffmpeg
SET = sys.argv[1]; TRAIN = SET == "train"
# Training clips only feed a head: shorter, coarser, unpadded.
HOP, PERCH_HOP, SECS, PADS = ( 80000, 80000, "15", 0 ) if TRAIN else ( 32000, 80000, "30", 4 )
FF = imageio_ffmpeg.get_ffmpeg_exe(); SR = 32000; W = 160000
SYN = {"Leuconotopicus villosus": "Dryobates villosus", "Hesperiphona vespertina": "Coccothraustes vespertinus",
       "Vireo swainsoni": "Vireo gilvus", "Setophaga aestiva": "Setophaga petechia",
       "Numenius hudsonicus": "Numenius phaeopus"}
keep = json.load(open("keep_species.json")); tid = [s["id"] for s in keep]
kidx = np.array(json.load(open("keep_idx.json")))
PL = [l.strip() for l in open("labels.txt")][1:]
pidx = []
for s in keep:
    n = s["name"]; c = [x for x in (n, SYN.get(n, n)) if x in PL]
    pidx.append(PL.index(c[0]) if c else -1)
pidx = np.array(pidx); print("perch missing:", [keep[i]["name"] for i in np.where(pidx < 0)[0]], flush=True)
o = ort.SessionOptions(); o.intra_op_num_threads = 4
bn = ort.InferenceSession("regional/north-america-west/birdnet-v3.0-preview3.1-north-america-west-fp32-b1.onnx", o)
pe = ort.InferenceSession("perch_v2_no_dft.onnx", o)
os.makedirs(f"cache/{SET}", exist_ok=True)
def frames(y, hop):
    return np.stack([y[j:j + W] for j in range(0, len(y) - W + 1, hop)])
meta = json.load(open(f"{SET}_meta.json"))
if TRAIN:
    c = {}; meta = [m for m in meta if c.setdefault(m["taxon_id"], [0]).append(1) or len(c[m["taxon_id"]]) <= 16]
for n, m in enumerate(meta):
    out = f"cache/{SET}/{m['obs']}.npz"
    if os.path.exists(out): continue
    try:
        y = np.frombuffer(subprocess.run([FF, "-v", "quiet", "-i", m["path"], "-t", SECS, "-ac", "1", "-ar", str(SR),
                                          "-f", "f32le", "-"], capture_output=True, timeout=120).stdout, np.float32)
    except Exception: y = np.zeros(0, np.float32)
    if len(y) < SR // 2: np.savez(out, bad=1); continue
    pad = np.zeros(PADS * SR, np.float32); y = np.concatenate([pad, y, pad])
    if len(y) < W: y = np.pad(y, (0, W - len(y)))
    X = frames(y, HOP); bp, be = [], []
    for b in range(0, len(X), 16):
        p, e = bn.run(None, {"input": X[b:b + 16]}); bp.append(p[:, kidx]); be.append(e)
    Xp = frames(y, PERCH_HOP); pl, pe_ = [], []
    for b in range(0, len(Xp), 8):
        r = pe.run(["embedding", "label"], {"inputs": Xp[b:b + 8]}); pe_.append(r[0]); pl.append(r[1][:, np.maximum(pidx, 0)])
    pl = np.concatenate(pl); pl[:, pidx < 0] = -30
    np.savez(out, bn=np.concatenate(bp).astype(np.float16), bne=np.concatenate(be).astype(np.float16),
             pl=pl.astype(np.float16), pee=np.concatenate(pe_).astype(np.float16))
    if n % 100 == 0: print(SET, n, len(meta), flush=True)
print(SET, "done", flush=True)
