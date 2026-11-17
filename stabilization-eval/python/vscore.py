import json, sys, pickle
import numpy as np
from multiprocessing import Pool
from stab import Analyzer, T, I3, fuse_robust
from judge import judge, rms, edge_zoom
from vision import load, app_today, readings, robust_path
from run import CLIPS
D = sys.argv[1]
R = "/home/user/iNaturalistReactNative/stabilization-eval/results/"

def variants(clip):
    f = np.load(f"{D}/{clip}.npy"); n, H, W = f.shape
    res = load(f"{R}{clip}.json"); assert len(res["frames"]) == n
    k = W / res["width"]
    out = {}
    out["App today (Vision)"] = app_today(res, W, H)
    st = np.array([[x["m"][2], x["m"][5]] for x in res["frames"]]) * k; st[0] = 0
    out["Vision steps chained, no frame-0 step"] = [T(*x) for x in np.cumsum(st, 0)]
    S, Rd = readings(res, W)
    # what the Mac's own tile chain ended at per frame: tc + median(tr) (gated)
    b2 = []
    for i, x in enumerate(res["frames"]):
        if i == 0: b2.append(I3); continue
        tc = np.array(x["tc"]) * k
        m = np.nanmedian(Rd[i], 0) if np.isfinite(Rd[i][:, 0]).sum() >= 3 else None
        b2.append(T(*(m if m is not None and np.linalg.norm(m - tc) < 0.1 * max(W, H) else tc)))
    out["Vision tiles, median"] = b2
    for lam in (0.1, 1.0):
        out[f"Vision tiles, robust fusion λ={lam}"] = robust_path(S, Rd, lam=lam)
    # phase-correlation (sub-pixel; Accelerate FFT on device)
    t = (4, 4)
    a = Analyzer(f, tiles=t, step_tiles=True).run()
    out["Phase-corr tiles, median"] = a["locks"]
    out["Phase-corr tiles, robust fusion"] = fuse_robust(a, 0.1, (W / 2, H / 2))
    a6 = Analyzer(f, tiles=(6, 6), step_tiles=True).run()
    out["Phase-corr 6x6 tiles, robust fusion"] = fuse_robust(a6, 0.1, (W / 2, H / 2))
    asim = Analyzer(f, tiles=t, step_tiles=True, similarity=True, max_roll=0.5).run()
    out["Phase-corr tiles + roll (guarded), fusion"] = fuse_robust(asim, 0.1, (W / 2, H / 2))
    out["Original"] = [I3] * n
    return out

def one(clip):
    f = np.load(f"{D}/{clip}.npy"); n, H, W = f.shape
    v = variants(clip); rows = {}
    for name, L in v.items():
        h, j = judge(f, L, CLIPS[clip]["box"])
        rows[name] = dict(hold=rms(h)[0], jitter=rms(j)[0], zoom=edge_zoom(L, W, H), locks=[np.asarray(x).tolist() for x in L])
        print(clip, name, "%.1f %.1f" % (rows[name]["hold"], rows[name]["jitter"]), flush=True)
    return clip, rows

if __name__ == "__main__":
    with Pool(3) as p: out = dict(p.map(one, list(CLIPS)))
    json.dump(out, open(f"{D}/vresults.json", "w"))
