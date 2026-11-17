import json, sys
import numpy as np
from stab import T
from render_all import render
D = sys.argv[1]
V = json.load(open(f"{D}/vresults2.json"))

def follow(L, sigma):
    x = np.array([np.array(l)[:2, 2] for l in L]); n = len(x)
    idx = np.arange(n); out = []
    for i in range(n):
        w = np.exp(-0.5 * ((idx - i) / sigma) ** 2); w /= w.sum()
        s = (w[:, None] * x).sum(0); out.append(T(*(x[i] - s)))
    return out

PANELS = [
    ("Original", "Original"),
    ("App today", "App today (Vision)"),
    ("App, frame-0 step removed", "Vision steps chained, no frame-0 step"),
    ("Vision tiles + robust fusion", "Vision tiles, robust fusion λ=0.3"),
    ("FFT tiles + robust fusion", "Phase-corr tiles, robust fusion"),
    ("Vision tiles, follows pans", None),
]
segs = []
for clip, title in [("3S1A8429", "1/3  Squirrel"), ("3S1A0091", "2/3  Blackbird"), ("3S1A1836", "3/3  Finch")]:
    f = np.load(f"{D}/{clip}.npy"); n, H, W = f.shape
    methods = []
    for label, key in PANELS:
        if key is None:
            L = follow(V[clip]["Vision tiles, robust fusion λ=0.3"]["locks"], 45)
            methods.append((label, L, "1.5 s follow; not a lock"))
            continue
        r = V[clip][key]
        L = None if key == "Original" else [np.array(l) for l in r["locks"]]
        note = "hold %.0f  shake %.1f  drift %.0f" % (r["hold"], r["jitter"], r["drift"])
        methods.append((label, L, note))
    segs.append((title, clip, n, W, H, methods))
render(f"{D}/../videos/stabilization_comparison.mp4", segs)
print("done")
