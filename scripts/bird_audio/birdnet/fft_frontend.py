# Replaces Audio ID's spectrogram front end, a Conv whose 2,050 filters are a
# periodic Hann window times cos and -sin at 1,025 frequencies (2048 taps,
# stride 512), and the re^2 + im^2 and transpose after it, with an STFT
# (opset 17), which ONNX Runtime computes by radix-2 FFT: the same power
# spectrum for ~1% of the Conv's 1.3 billion multiply-adds per 5 s window
# (16% of the model's), without its 4.2M filter weights, and in fp32 rather
# than fp16. build_model.py calls fft_frontend(); on its own it rewrites the
# committed model in place:
#   python3 fft_frontend.py <repo root>
import os, sys
import numpy as np, onnx
from onnx import TensorProto, helper, numpy_helper

P = "/preprocess/torchSpecTransform/"
WEIGHT = "preprocess.torchSpecTransform.weight"
REMOVED = [P + "Unsqueeze", P + "Unsqueeze_output_cast0", P + "Conv", P + "Slice_1", P + "Slice_2",
           P + "Mul", P + "Mul_1", P + "Add", "/preprocess/Transpose"]


def fft_frontend(m):
    g = m.graph
    nodes = {n.name: n for n in g.node}
    if P + "Conv" not in nodes:
        return False  # already rewritten
    conv = nodes[P + "Conv"]
    attrs = {a.name: helper.get_attribute_value(a) for a in conv.attribute}
    weight = next(t for t in g.initializer if t.name == WEIGHT)
    w = numpy_helper.to_array(weight).astype(np.float32)[:, 0, :]
    n_fft, bins = w.shape[1], w.shape[0] // 2
    assert attrs["strides"] == [512] and bins == n_fft // 2 + 1, (attrs, w.shape)
    # Row 0 is the window times cos(0); check the rest is the DFT it implies.
    window = w[0]
    k, n = np.arange(bins)[:, None], np.arange(n_fft)
    angle = 2 * np.pi * k * n / n_fft
    assert np.abs(w[:bins] - window * np.cos(angle)).max() < 2e-3
    assert np.abs(w[bins:] + window * np.sin(angle)).max() < 2e-3

    padded = P + "Pad_output_cast_0"  # [batch, samples], fp32, reflect-padded by n_fft / 2
    out = "/preprocess/Transpose_output_0"  # power, [batch, frames, bins], fp16
    for name in REMOVED:
        g.node.remove(nodes[name])
    g.initializer.remove(weight)
    pre = "/preprocess/stft/"
    g.initializer.extend([
        numpy_helper.from_array(np.array([2], np.int64), pre + "axis2"),
        numpy_helper.from_array(np.array([-1], np.int64), pre + "last"),
        numpy_helper.from_array(np.array(attrs["strides"][0], np.int64), pre + "step"),
        numpy_helper.from_array(window, pre + "window"),
        numpy_helper.from_array(np.array(n_fft, np.int64), pre + "length"),
    ])
    new = [
        helper.make_node("Unsqueeze", [padded, pre + "axis2"], [pre + "signal"], name=pre + "Unsqueeze"),
        # [batch, frames, bins, 2]: real and imaginary parts.
        helper.make_node("STFT", [pre + "signal", pre + "step", pre + "window", pre + "length"],
                         [pre + "spectrum"], name=pre + "STFT", onesided=1),
        helper.make_node("ReduceSumSquare", [pre + "spectrum", pre + "last"], [pre + "power"],
                         name=pre + "Power", keepdims=0),
        helper.make_node("Cast", [pre + "power"], [out], name=pre + "Cast", to=TensorProto.FLOAT16),
    ]
    # Keep the graph topologically sorted: put the new nodes where the Conv was.
    at = list(g.node).index(next(x for x in g.node if out in x.input))
    for i, node in enumerate(new):
        g.node.insert(at + i, node)
    used = {i for x in g.node for i in x.input}
    for t in [t for t in g.initializer if t.name.startswith(P) and t.name not in used]:
        g.initializer.remove(t)
    del g.value_info[:]
    return True


if __name__ == "__main__":
    ios = f"{sys.argv[1]}/ios/iNaturalistReactNative"
    m = onnx.load(f"{ios}/audio_id.onnx")
    if not fft_frontend(m):
        sys.exit("already uses the STFT front end")
    onnx.checker.check_model(m)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from model_files import save_weights  # noqa: E402
    print(save_weights(m, ios), "weight files")
