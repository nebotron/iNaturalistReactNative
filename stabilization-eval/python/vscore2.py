import json, sys
import numpy as np, cv2
from multiprocessing import Pool
from judge import score, texture_mask, rms
from vision import load, readings, robust_path
from run import CLIPS
D = sys.argv[1]; R = "/home/user/iNaturalistReactNative/stabilization-eval/results/"
V = json.load(open(f"{D}/vresults.json"))

def drift(f, L, box, gap=30):
    n, H, W = f.shape
    ones = np.ones((H, W), np.uint8)
    ns = np.ones((H, W), bool); x0, y0, x1, y1 = box; ns[y0:y1, x0:x1] = False
    out = []
    for i in range(0, n - gap, 3):
        a = cv2.warpPerspective(f[i], np.array(L[i]), (W, H)); b = cv2.warpPerspective(f[i + gap], np.array(L[i + gap]), (W, H))
        ca = cv2.warpPerspective(ones, np.array(L[i]), (W, H), flags=cv2.INTER_NEAREST); cb = cv2.warpPerspective(ones, np.array(L[i + gap]), (W, H), flags=cv2.INTER_NEAREST)
        m = cv2.erode(ca & cb, np.ones((9, 9), np.uint8)).astype(bool)
        out.append(score(a, b, texture_mask(a) & ns & m))
    return rms(out)[0]

def one(clip):
    f = np.load(f"{D}/{clip}.npy"); n, H, W = f.shape
    res = load(f"{R}{clip}.json"); S, Rd = readings(res, W)
    extra = {f"Vision tiles, robust fusion λ={l}": robust_path(S, Rd, lam=l) for l in (0.3,)}
    rows = {}
    for name in list(V[clip]) + list(extra):
        L = extra[name] if name in extra else V[clip][name]["locks"]
        rows[name] = dict(drift=drift(f, L, CLIPS[clip]["box"]))
        if name in extra:
            from judge import judge, edge_zoom
            h, j = judge(f, L, CLIPS[clip]["box"])
            rows[name].update(hold=rms(h)[0], jitter=rms(j)[0], locks=[np.asarray(x).tolist() for x in L])
        else:
            rows[name].update({k: V[clip][name][k] for k in ("hold", "jitter", "locks")})
    return clip, rows

if __name__ == "__main__":
    with Pool(3) as p: out = dict(p.map(one, list(CLIPS)))
    json.dump(out, open(f"{D}/vresults2.json", "w"))
    print("%-44s" % "hold / jitter / 1s-drift", *["%-22s" % c for c in out])
    for n in out["3S1A8429"]:
        print("%-44s" % n, *["%5.1f /%5.1f /%5.1f    " % (out[c][n]["hold"], out[c][n]["jitter"], out[c][n]["drift"]) for c in out])
