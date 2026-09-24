# Cuts BirdNET v3.0 (NA-west, published fp16 build) down to the Seattle
# species. Every per-class tensor (attention/classification convs and the
# linear head) is sliced along its class axis; the attention softmax runs over
# time, not classes, so kept species score exactly as in the full model.
# Usage: python3 slice_model.py <in.onnx> <out.onnx> <kept class indices.json>
import json, sys, numpy as np, onnx
from onnx import numpy_helper
src,dst,idx_file=sys.argv[1:4]
idx=np.array(json.load(open(idx_file)))
m=onnx.load(src); g=m.graph
out=g.output[0]                          # class scores; the second output is embeddings
N=out.type.tensor_type.shape.dim[1].dim_value
n=0
for i,t in enumerate(g.initializer):
    a=numpy_helper.to_array(t)
    if a.ndim and a.shape[0]==N and t.name.startswith(("att_block","head.")):
        g.initializer[i].CopyFrom(numpy_helper.from_array(a[idx],t.name)); n+=1
print("sliced",n,"tensors")
del g.value_info[:]                        # stale 802-class shapes
out.type.tensor_type.shape.dim[1].dim_value=len(idx)
for o in list(g.output[1:]): g.output.remove(o)
onnx.save(m,dst)
