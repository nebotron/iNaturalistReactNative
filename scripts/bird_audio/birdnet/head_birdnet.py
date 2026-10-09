# Trains a linear head on BirdNET's 1280-d embedding from older iNaturalist
# recordings (cache/train, written by score.py train) and builds the app model:
# BirdNET v3.0 sliced to the Seattle species, whose score for each species with
# training data is averaged with the head's softmax probability.
# Usage: python3 head_birdnet.py <NA-west fp16.onnx> audio_birds.onnx
import json, os, sys, numpy as np, onnx
from onnx import helper, numpy_helper
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
src, dst = sys.argv[1:3]
keep = json.load(open("keep_species.json")); tid = [s["id"] for s in keep]; K = len(keep)
idx = np.array(json.load(open("keep_idx.json")))

# Two highest-scoring windows of each recording for its species, plus the
# lowest-scoring window as background when BirdNET hears nothing in it.
X, Y = [], []
for m in json.load(open("train_meta.json")):
    p = f"cache/train/{m['obs']}.npz"
    if m["taxon_id"] not in tid or not os.path.exists(p): continue
    z = np.load(p)
    if "bad" in z: continue
    k = tid.index(m["taxon_id"]); st = z["bn"][:, k].astype(np.float32); o = np.argsort(-st)
    for j in o[:2]: X.append(z["bne"][j]); Y.append(k)
    if len(o) > 2 and st[o[-1]] < 0.05: X.append(z["bne"][o[-1]]); Y.append(K)
X = np.array(X, np.float32); sc = StandardScaler().fit(X)
clf = LogisticRegression(C=0.05, max_iter=300).fit(sc.transform(X), Y)
cls = clf.classes_; print(f"head: {len(X)} windows, {len(cls) - 1} species")
W = ( clf.coef_.T / sc.scale_[:, None] ).astype(np.float32)        # standardisation folded in
b = ( clf.intercept_ - ( sc.mean_ / sc.scale_ ) @ clf.coef_.T ).astype(np.float32)
sel = np.zeros((len(cls), K), np.float32); a = np.ones(K, np.float32)
for c, k in enumerate(cls):
    if k < K: sel[c, k] = 0.5; a[k] = 0.5

m = onnx.load(src); g = m.graph
N = g.output[0].type.tensor_type.shape.dim[1].dim_value
for i, t in enumerate(g.initializer):  # slice classes, as slice_birdnet.py
    v = numpy_helper.to_array(t)
    if v.ndim and v.shape[0] == N and t.name.startswith(("att_block", "head.")):
        g.initializer[i].CopyFrom(numpy_helper.from_array(v[idx], t.name))
del g.value_info[:]
for n in g.node:
    n.output[:] = ["bn_scores" if o == "output" else o for o in n.output]
g.initializer.extend(numpy_helper.from_array(v, n) for n, v in
                     (("head_w", W), ("head_b", b), ("head_sel", sel), ("head_a", a)))
g.node.extend([
    helper.make_node("MatMul", ["embeddings", "head_w"], ["head_z0"]),
    helper.make_node("Add", ["head_z0", "head_b"], ["head_z"]),
    helper.make_node("Softmax", ["head_z"], ["head_p"], axis=1),
    helper.make_node("MatMul", ["head_p", "head_sel"], ["head_half"]),
    helper.make_node("Mul", ["bn_scores", "head_a"], ["bn_part"]),
    helper.make_node("Add", ["bn_part", "head_half"], ["output"]),
])
g.output[0].type.tensor_type.shape.dim[1].dim_value = K
for o in list(g.output[1:]): g.output.remove(o)
onnx.checker.check_model(m); onnx.save(m, dst); print("wrote", dst)
