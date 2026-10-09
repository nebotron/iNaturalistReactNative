# Recording-level precision/recall of each proposed change on the held-out eval set.
# A recording is labelled with one species; a detection of any other species counts as
# a false positive (an upper bound: some are real background birds).
import json, os, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
import onnxruntime as ort
rng = np.random.default_rng(0)
SYN = {"Leuconotopicus villosus": "Dryobates villosus", "Hesperiphona vespertina": "Coccothraustes vespertinus",
       "Vireo swainsoni": "Vireo gilvus", "Setophaga aestiva": "Setophaga petechia",
       "Numenius hudsonicus": "Numenius phaeopus"}
keep = json.load(open("keep_species.json")); tid = [s["id"] for s in keep]; K = len(keep)
sig = lambda x: 1 / (1 + np.exp(-x))

def load(set_):
    R = []
    for m in json.load(open(f"{set_}_meta.json")):
        p = f"cache/{set_}/{m['obs']}.npz"
        if not os.path.exists(p) or m["taxon_id"] not in tid: continue
        z = np.load(p)
        if "bad" in z: continue
        R.append(dict(m, t=tid.index(m["taxon_id"]), **{k: z[k].astype(np.float32) for k in ("bn", "bne", "pl", "pee")}))
    return R
E = load("eval"); T = load("train")
t = np.array([r["t"] for r in E]); N = len(E); users = np.array([r["user"] for r in E])
print(f"eval {N} recordings, {len(np.unique(t))} species; train {len(T)}")

# --- geomodel: occurrence score for each recording's place and week
GL = [l.rstrip("\n").split("\t")[1] for l in open("BirdNET+_Geomodel_V3.0.3_Global_12K_Labels.txt")]
gidx = np.array([GL.index(SYN.get(s["name"], s["name"])) if SYN.get(s["name"], s["name"]) in GL
                 else (GL.index(s["name"]) if s["name"] in GL else -1) for s in keep])
print("geomodel missing:", [keep[i]["name"] for i in np.where(gidx < 0)[0]])
gm = ort.InferenceSession("BirdNET+_Geomodel_V3.0.3_Global_12K_FP32.onnx")
def week(d):
    y, mo, da = map(int, d.split("-")); return (mo - 1) * 4 + min(4, (da - 1) // 7 + 1)
G = np.ones((N, K), np.float32); has_geo = np.zeros(N, bool)
for i, r in enumerate(E):
    if r["lat"] is None or not r["date"]: continue
    g = gm.run(None, {"input": np.array([[r["lat"], r["lng"], week(r["date"])]], np.float32)})[0][0]
    G[i] = np.where(gidx >= 0, g[np.maximum(gidx, 0)], 1); has_geo[i] = True
print(f"geo for {has_geo.mean():.0%} of recordings")

# --- recording-level scores
def pool(windows, f="max"): return np.stack([f(w) for w in windows])
def kmin(w, k):  # best run of k consecutive windows (all must clear the threshold)
    if len(w) < k: return w.min(0)
    return np.max(np.stack([w[j:j + k] for j in range(len(w) - k + 1)]).min(1), 0)
def kmean(w, k):
    if len(w) < k: return w.mean(0)
    c = np.cumsum(np.vstack([np.zeros((1, w.shape[1])), w]), 0); return ((c[k:] - c[:-k]) / k).max(0)
BN = pool([r["bn"] for r in E], lambda w: w.max(0))
# Perch logits are not probabilities: Platt-scale them on the (older) training recordings.
def platt():
    x, y = [], []
    for r in T:
        m = r["pl"].max(0); x += list(m); y += [k == r["t"] for k in range(K)]
    lr = LogisticRegression().fit(np.array(x)[:, None], y); a, b = lr.coef_[0, 0], lr.intercept_[0]
    print(f"Perch Platt: a {a:.2f} b {b:.2f}"); return lambda l: sig(a * l + b)
pcal = platt() if T else sig
PE = pool([pcal(r["pl"]) for r in E], lambda w: w.max(0))

def metrics(S, th):
    th = np.broadcast_to(th, (K,)); det = S >= th
    tp = det[np.arange(N), t]; fp = det.sum(1) - tp
    return dict(recall=tp.mean(), precision=tp.sum() / max(1, det.sum()), fp_per_rec=fp.mean(),
                top1=(S.argmax(1) == t).mean())
def at_recall(S, target):  # precision when the global threshold is set to reach a recall
    s = S[np.arange(N), t]; th = np.quantile(s, 1 - target); return th, metrics(S, th)
def ap(S):  # micro average precision over all recording x species pairs
    y = np.zeros_like(S, bool); y[np.arange(N), t] = True
    o = np.argsort(-S.ravel()); yy = y.ravel()[o]; c = np.cumsum(yy)
    return (c[yy] / (np.where(yy)[0] + 1)).sum() / yy.sum()

rows = []
def report(name, S, th=0.5, note=""):
    m = metrics(S, th); _, m85 = at_recall(S, .85); _, m90 = at_recall(S, .90)
    rows.append(dict(method=name, **{k: round(float(v), 3) for k, v in m.items()}, AP=round(float(ap(S)), 3),
                     prec_at_R85=round(float(m85["precision"]), 3), prec_at_R90=round(float(m90["precision"]), 3),
                     note=note))
    print(f"{name:44s} R {m['recall']:.3f} P {m['precision']:.3f} FP/rec {m['fp_per_rec']:.2f} "
          f"top1 {m['top1']:.3f} AP {ap(S):.3f} P@R.85 {m85['precision']:.3f} P@R.90 {m90['precision']:.3f}", flush=True)

report("baseline (app today)", BN)
for th in (0.6, 0.7, 0.8, 0.9): report(f"0. global threshold {th}", BN, th)
det = BN >= 0.5; det[np.arange(N), t] = False; c = det.sum(0); o = np.argsort(-c)[:10]
print("most-flagged wrong species @0.5:", [(keep[k]["common"], int(c[k])) for k in o])
# 1. geomodel
for tau in (0.01, 0.03, 0.05, 0.1):
    report(f"1. geo filter (occurrence >= {tau})", BN * (G >= tau))
report("1. geo weighting (score x occurrence^0.25)", BN * G ** .25)
# 3. temporal persistence
for k in (2, 3):
    report(f"3. {k} consecutive windows >= threshold", pool([r["bn"] for r in E], lambda w: kmin(w, k)))
report("3. mean of 3 consecutive windows", pool([r["bn"] for r in E], lambda w: kmean(w, 3)))
# 2. per-species thresholds, 2-fold cross-validated, folds split by observer
def fit_thresholds(S, tt, target_p):
    th = np.full(K, 0.5)
    for k in range(K):
        pos = S[tt == k, k]; neg = S[tt != k, k]
        if len(pos) < 5: continue
        best = None
        for c in np.arange(0.2, 0.96, 0.025):  # lowest threshold reaching the target precision
            tp = (pos >= c).sum(); fp = (neg >= c).sum()
            if tp and tp / (tp + fp) >= target_p: best = c; break
        th[k] = best if best is not None else 0.95
    return th
def cv_thresholds(S, target_p):
    u = np.unique(users); fold = np.isin(users, rng.permutation(u)[:len(u) // 2]); TH = np.zeros((N, K))
    for f in (fold, ~fold): TH[~f] = fit_thresholds(S[f], t[f], target_p)
    return TH
def report_th(name, S, TH):
    det = S >= TH; tp = det[np.arange(N), t]; fp = det.sum(1) - tp
    rec, prec = tp.mean(), tp.sum() / det.sum()
    th_g, mg = at_recall(S, rec)
    rows.append(dict(method=name, recall=round(float(rec), 3), precision=round(float(prec), 3),
                     fp_per_rec=round(float(fp.mean()), 3), note=f"global threshold at same recall: P {mg['precision']:.3f}"))
    print(f"{name:44s} R {rec:.3f} P {prec:.3f} FP/rec {fp.mean():.2f}   (global th {th_g:.2f} at same recall: P {mg['precision']:.3f})", flush=True)
for tp_ in (0.5, 0.6, 0.7):
    report_th(f"2. per-species thresholds (target P {tp_})", BN, cv_thresholds(BN, tp_))
# Perch v2 and ensemble
report("Perch v2 alone (Platt-scaled)", PE)
report("BirdNET + Perch mean", (BN + PE) / 2)
report("BirdNET + Perch geometric mean", np.sqrt(BN * PE))
# 4. linear heads on embeddings, trained on older observations
def head(feat, base):
    X, Y = [], []
    for r in T:
        e = r[feat]; s = r[base] if base == "bn" else r["pl"]; st = s[:, r["t"]]; o = np.argsort(-st)
        for j in o[:2]: X.append(e[j]); Y.append(r["t"])
        if len(o) > 2 and st[o[-1]] < 0.05: X.append(e[o[-1]]); Y.append(K)  # background
    X = np.array(X); sc = StandardScaler().fit(X)
    clf = LogisticRegression(C=0.05, max_iter=300).fit(sc.transform(X), Y)
    cols = list(clf.classes_)
    def score(r):
        p = clf.predict_proba(sc.transform(r[feat])); out = np.zeros((len(p), K))
        for c, k in enumerate(cols):
            if k < K: out[:, k] = p[:, c]
        return out.max(0)
    print(f"head on {feat}: {len(X)} windows, {len(set(Y)) - 1} species")
    return np.stack([score(r) for r in E])
if T:
    HB = head("bne", "bn"); HP = head("pee", "pl")
    report("4. BirdNET-embedding head", HB); report("4. BirdNET + its head (mean)", (BN + HB) / 2)
    report("4. Perch-embedding head", HP); report("4. Perch + its head (mean)", (PE + HP) / 2)
# combined
KM = pool([r["bn"] for r in E], lambda w: kmin(w, 2))
report("1+3. geo filter 0.03 + 2 consecutive", KM * (G >= 0.03))
report_th("1+2+3. geo + 2 consec + per-species th (P .6)", KM * (G >= 0.03), cv_thresholds(KM * (G >= 0.03), 0.6))
json.dump(rows, open("results.json", "w"), indent=1)
