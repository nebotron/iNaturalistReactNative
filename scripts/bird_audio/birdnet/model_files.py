# Writes audio_id.onnx with its weights in audio_id.data<N> files under 95 MB
# each (GitHub's limit is 100 MB). The Xcode project bundles audio_id.data0-1,
# so update it if the count changes.
import glob, os
import onnx
from onnx.external_data_helper import set_external_data

CHUNK = 95_000_000


def save_weights(m, ios):
    for f in glob.glob(f"{ios}/audio_id.data*"): os.remove(f)
    n, f, off = 0, None, 0
    for t in m.graph.initializer:
        if len(t.raw_data) < 4096: continue
        if f is None or off + len(t.raw_data) > CHUNK:
            if f: f.close()
            name = f"audio_id.data{n}"; f = open(f"{ios}/{name}", "wb"); n += 1; off = 0
        data = t.raw_data; f.write(data); set_external_data(t, name, off, len(data)); t.ClearField("raw_data")
        t.data_location = onnx.TensorProto.EXTERNAL; off += len(data)
    f.close()
    onnx.save(m, f"{ios}/audio_id.onnx")
    return n
