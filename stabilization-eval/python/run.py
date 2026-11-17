import json
import sys
import time
from multiprocessing import Pool

import numpy as np

from judge import edge_zoom, judge, rms
from stab import I3, Analyzer, fuse, fuse_robust

D = sys.argv[1]
ONLY2 = len(sys.argv) > 2

CLIPS = {
    # judge's subject box (x0, y0, x1, y1) and the user's tap, data px on frame 0
    "3S1A8429": dict(box=(300, 120, 660, 490), tap=(450, 300)),
    "3S1A0091": dict(box=(150, 150, 540, 830), tap=(350, 500)),
    "3S1A1836": dict(box=(400, 210, 540, 310), tap=(465, 260)),
}


def methods(clip, frames):
    H, W = frames.shape[1:]
    c = (W / 2, H / 2)
    tap = CLIPS[clip]["tap"]
    half = 0.25 * min(W, H) / 2 * 2   # the app's box (1/4 short side), doubled for margin
    subj = (tap[0], tap[1], half)
    t = (4, 4)
    out = {}

    def add(name, **kw):
        t0 = time.time()
        a = Analyzer(frames, **kw).run()
        out[name] = (a, time.time() - t0)
        return a
    if ONLY2:
        b2 = add("B2: tile steps + tile residual", tiles=t, step_tiles=True)
        b2c = add("B2 + C", tiles=t, step_tiles=True, subject=subj)
        add("B-sim, roll guard 0.5°", tiles=t, similarity=True, max_roll=0.5)
        b2s = add("B2 + C + sim, roll guard", tiles=t, step_tiles=True, subject=subj, similarity=True, max_roll=0.5)
        res = {k: (v[0]["locks"], v[1]) for k, v in out.items()}
        for lam in (0.02, 0.1):
            res[f"A robust + B2 (λ={lam})"] = (fuse_robust(b2, lam, c), 0)
            res[f"A robust + B2 + C (λ={lam})"] = (fuse_robust(b2c, lam, c), 0)
            res[f"A robust + B2 + C + sim (λ={lam})"] = (fuse_robust(b2s, lam, c), 0)
        return res
    base = add("base (app today)")
    add("base, whole-pixel shifts", integer=True)
    add("D: 960 px", scale=1.0)
    add("B: tiles, median shift", tiles=t)
    add("B: tiles, similarity", tiles=t, similarity=True)
    add("C: B-sim + skip subject", tiles=t, similarity=True, subject=subj)
    add("E: keyframes", keyframes=True)
    add("B+C+E", tiles=t, similarity=True, subject=subj, keyframes=True)
    res = {k: (v[0]["locks"], v[1]) for k, v in out.items()}
    for lam in (0.02, 0.1, 0.5):
        res[f"A: fuse λ={lam}"] = (fuse(base, lam, c), 0)
    for lam in (0.02, 0.1):
        res[f"A robust: fuse λ={lam}"] = (fuse_robust(base, lam, c), 0)
    bsim = out["B: tiles, similarity"][0]
    res["A robust + B-sim (λ=0.1)"] = (fuse_robust(bsim, 0.1, c), 0)
    bc = out["C: B-sim + skip subject"][0]
    res["A robust + B-sim + C (λ=0.1)"] = (fuse_robust(bc, 0.1, c), 0)
    bce = out["B+C+E"][0]
    res["A robust + B+C+E (λ=0.1)"] = (fuse_robust(bce, 0.1, c), 0)
    res["A+B+C+E (λ=0.1)"] = (fuse(bce, 0.1, c), 0)
    res["none (unstabilized)"] = ([I3] * len(frames), 0)
    return res


def one(clip):
    frames = np.load(f"{D}/{clip}.npy")
    H, W = frames.shape[1:]
    rows = {}
    for name, (locks, secs) in methods(clip, frames).items():
        hold, jit = judge(frames, locks, CLIPS[clip]["box"])
        h, hn = rms(hold)
        j, jn = rms(jit)
        ang = [np.degrees(np.arctan2(L[1, 0], L[0, 0])) for L in locks]
        rows[name] = dict(hold=h, hold_n=hn, jitter=j, jitter_n=jn,
                          zoom=edge_zoom(locks, W, H), secs=secs,
                          max_roll=float(np.max(np.abs(ang))),
                          hold_series=hold, jit_series=jit,
                          locks=[L.tolist() for L in locks])
        print(clip, name, f"hold {h:.2f} ({hn}) jitter {j:.2f} ({jn})", flush=True)
    return clip, rows


if __name__ == "__main__":
    with Pool(3) as p:
        results = dict(p.map(one, list(CLIPS)))
    json.dump(results, open(f"{D}/results2.json" if ONLY2 else f"{D}/results.json", "w"))
