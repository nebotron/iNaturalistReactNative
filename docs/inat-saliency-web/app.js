/**
 * Browser saliency for the iNaturalist vision ONNX export (NHWC float32 RGB 0–255).
 * Same weights as official v25.01.15 TFLite, dequantized for ORT Web.
 * SmoothGrad-style Monte Carlo estimate of ∂ p(class) / ∂ pixel (forward passes only).
 *
 * Requires global `ort` from https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js
 */

import { TURBO_LUT } from "./turbo_lut.js";

const MODEL_URL = new URL("./inat_vision_dequant.onnx", import.meta.url).href;
const DEFAULT_BEAR_URL = new URL("./default-bear.jpg", import.meta.url).href;
const INPUT_NAME = "serving_default_input_1:0";
const OUTPUT_NAME = "StatefulPartitionedCall:0";

const H = 299;
const W = 299;
const C = 3;
const L = H * W * C;

const $ = (id) => document.getElementById(id);

const ort = /** @type {any} */ (window).ort;
if (!ort?.InferenceSession?.create) {
  const st = $("status");
  if (st) {
    st.textContent =
      "ONNX Runtime Web failed to load. Check your network connection or browser extensions.";
    st.classList.add("error");
  }
  throw new Error("ort missing");
}

const statusEl = $("status");
const runBtn = $("runBtn");
const imageFile = $("imageFile");
const samplesEl = $("samples");
const samplesVal = $("samplesVal");
const sigmaEl = $("sigma");
const sigmaVal = $("sigmaVal");
const outSection = $("outSection");
const inputCanvas = $("inputCanvas");
const overlayCanvas = $("overlayCanvas");

const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext("2d", { willReadFrequently: true });

let session = null;
let imageBitmap = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function softmaxInPlace(logits) {
  let m = -Infinity;
  for (let i = 0; i < logits.length; i += 1) {
    if (logits[i] > m) m = logits[i];
  }
  let s = 0;
  for (let i = 0; i < logits.length; i += 1) {
    const e = Math.exp(logits[i] - m);
    logits[i] = e;
    s += e;
  }
  for (let i = 0; i < logits.length; i += 1) {
    logits[i] /= s;
  }
}

function argmax(arr) {
  let j = 0;
  let m = -Infinity;
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] > m) {
      m = arr[i];
      j = i;
    }
  }
  return j;
}

function randn(out) {
  for (let i = 0; i < out.length; i += 2) {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u));
    out[i] = mag * Math.cos(2 * Math.PI * v);
    if (i + 1 < out.length) {
      out[i + 1] = mag * Math.sin(2 * Math.PI * v);
    }
  }
}

function percentileLinear(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = ((sorted.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function percentile2d(mag2d, q) {
  const flat = mag2d.slice().sort((a, b) => a - b);
  return percentileLinear(flat, q);
}

/**
 * Match Python `minimal_square_bbox_xyxy` (inclusive coords).
 * @param {Float32Array} mag row-major length H*W
 */
function minimalSquareBbox(mag, quantile = 93, minPeakFrac = 0.18) {
  let peak = -Infinity;
  for (let i = 0; i < mag.length; i += 1) {
    if (mag[i] > peak) peak = mag[i];
  }
  const thr0 = Math.max(peak * minPeakFrac, percentile2d(mag, quantile));
  const ys = [];
  const xs = [];
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const v = mag[y * W + x];
      if (v >= thr0) {
        ys.push(y);
        xs.push(x);
      }
    }
  }
  if (ys.length === 0) {
    const thr1 = percentile2d(mag, 85);
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const v = mag[y * W + x];
        if (v >= thr1) {
          ys.push(y);
          xs.push(x);
        }
      }
    }
  }
  if (ys.length === 0) return null;

  let ymin = H;
  let ymax = 0;
  let xmin = W;
  let xmax = 0;
  for (let i = 0; i < ys.length; i += 1) {
    const y = ys[i];
    const x = xs[i];
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
  }

  const bw = xmax - xmin + 1;
  const bh = ymax - ymin + 1;
  let side = Math.max(bw, bh);
  if (side > Math.min(H, W)) side = Math.min(H, W);

  const cx = 0.5 * (xmin + xmax);
  const cy = 0.5 * (ymin + ymax);
  let x0 = Math.floor(cx - (side - 1) / 2);
  let y0 = Math.floor(cy - (side - 1) / 2);
  x0 = clamp(x0, 0, W - side);
  y0 = clamp(y0, 0, H - side);
  const x1 = x0 + side - 1;
  const y1 = y0 + side - 1;
  return [x0, y0, x1, y1];
}

function imageToInputTensor(bitmap) {
  inputCtx.imageSmoothingEnabled = true;
  inputCtx.imageSmoothingQuality = "high";
  inputCtx.clearRect(0, 0, W, H);
  inputCtx.drawImage(bitmap, 0, 0, W, H);
  const { data } = inputCtx.getImageData(0, 0, W, H);
  const x = new Float32Array(L);
  let p = 0;
  for (let y = 0; y < H; y += 1) {
    for (let xpix = 0; xpix < W; xpix += 1) {
      const i = (y * W + xpix) * 4;
      x[p] = data[i];
      x[p + 1] = data[i + 1];
      x[p + 2] = data[i + 2];
      p += 3;
    }
  }
  return x;
}

function magnitudeMeanAbsChannels(grad) {
  const mag = new Float32Array(H * W);
  let p = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const ax = Math.abs(grad[p]);
      const ay = Math.abs(grad[p + 1]);
      const az = Math.abs(grad[p + 2]);
      mag[y * W + x] = (ax + ay + az) / 3;
      p += 3;
    }
  }
  return mag;
}

function colorizeAndBlend(rgbFlat, mag, alpha = 0.55) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < mag.length; i += 1) {
    const v = mag[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const span = mx - mn;
  const img = overlayCtx.createImageData(W, H);
  const d = img.data;
  let p = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const m = mag[y * W + x];
      const t = span > 0 ? (m - mn) / span : 0;
      const li = Math.min(255, Math.max(0, Math.floor(t * 255)));
      const [tr, tg, tb] = TURBO_LUT[li];
      const br = rgbFlat[p];
      const bg = rgbFlat[p + 1];
      const bb = rgbFlat[p + 2];
      const di = (y * W + x) * 4;
      d[di] = (1 - alpha) * br + alpha * tr;
      d[di + 1] = (1 - alpha) * bg + alpha * tg;
      d[di + 2] = (1 - alpha) * bb + alpha * tb;
      d[di + 3] = 255;
      p += 3;
    }
  }
  overlayCtx.putImageData(img, 0, 0);
}

function drawBbox(xyxy, color = [0, 255, 90], lineWidth = 3) {
  const [x0, y0, x1, y1] = xyxy;
  overlayCtx.save();
  overlayCtx.strokeStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
  overlayCtx.lineWidth = lineWidth;
  const rw = x1 - x0 + 1;
  const rh = y1 - y0 + 1;
  overlayCtx.strokeRect(x0 + 0.5, y0 + 0.5, rw, rh);
  overlayCtx.restore();
}

async function createSessionFromBuffer(buffer) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/";
  return ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
}

async function runSaliency() {
  if (!session || !imageBitmap) return;

  const nSamples = Number(samplesEl.value);
  const sigma = Number(sigmaEl.value);
  runBtn.disabled = true;
  outSection.hidden = false;

  const x0 = imageToInputTensor(imageBitmap);
  inputCtx.drawImage(imageBitmap, 0, 0, W, H);

  const feeds0 = {
    [INPUT_NAME]: new ort.Tensor("float32", x0, [1, H, W, C]),
  };
  setStatus("Baseline forward pass…");
  const out0 = await session.run(feeds0);
  const logits0 = new Float32Array(out0[OUTPUT_NAME].data);
  softmaxInPlace(logits0);
  const classIndex = argmax(logits0);
  const p0 = logits0[classIndex];

  const acc = new Float32Array(L);
  const xNoisy = new Float32Array(L);
  const z = new Float32Array(L);

  for (let s = 0; s < nSamples; s += 1) {
    randn(z);
    for (let i = 0; i < L; i += 1) {
      xNoisy[i] = clamp(x0[i] + sigma * z[i], 0, 255);
    }
    const feeds = {
      [INPUT_NAME]: new ort.Tensor("float32", xNoisy, [1, H, W, C]),
    };
    const out = await session.run(feeds);
    const logits = new Float32Array(out[OUTPUT_NAME].data);
    softmaxInPlace(logits);
    const diff = logits[classIndex] - p0;
    const scale = diff / sigma;
    for (let i = 0; i < L; i += 1) {
      acc[i] += z[i] * scale;
    }
    if (s % 4 === 3) {
      setStatus(`Monte Carlo saliency: ${s + 1} / ${nSamples} samples…`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const inv = 1 / nSamples;
  for (let i = 0; i < L; i += 1) {
    acc[i] *= inv;
  }

  const mag = magnitudeMeanAbsChannels(acc);
  colorizeAndBlend(x0, mag, 0.55);
  const bbox = minimalSquareBbox(mag);
  if (bbox) {
    drawBbox(bbox);
  }

  setStatus(
    `Top class index: ${classIndex}\n`
      + `Estimated saliency used ${nSamples} forward passes (σ=${sigma}).\n`
      + (bbox ? `Salient square (inclusive): ${bbox.join(", ")}` : "No salient square (empty mask)."),
  );
  runBtn.disabled = false;
}

function updateSliders() {
  samplesVal.textContent = samplesEl.value;
  sigmaVal.textContent = sigmaEl.value;
}

imageFile.addEventListener("change", async () => {
  const f = imageFile.files?.[0];
  if (!f) return;
  try {
    imageBitmap = await createImageBitmap(f);
    setStatus("Running saliency on your photo…");
    await runSaliency();
  } catch (e) {
    imageBitmap = null;
    runBtn.disabled = true;
    setStatus(`Could not read image: ${e}`, true);
  }
});

samplesEl.addEventListener("input", updateSliders);
sigmaEl.addEventListener("input", updateSliders);
updateSliders();

runBtn.addEventListener("click", () => {
  runSaliency().catch((e) => {
    setStatus(`Run failed: ${e}`, true);
    runBtn.disabled = false;
  });
});

async function init() {
  try {
    setStatus(
      "Loading vision model (dequantized ONNX, ~82 MB — first visit may take a while)…",
    );
    const res = await fetch(MODEL_URL, { cache: "force-cache" });
    if (!res.ok) {
      throw new Error(
        `Could not fetch inat_vision_dequant.onnx (${res.status}). This file ships with the demo in git; if you forked the repo without it, regenerate it with tools/inat_vision_saliency and copy it here.`,
      );
    }
    const buf = await res.arrayBuffer();
    session = await createSessionFromBuffer(buf);

    setStatus("Loading default bear photo…");
    const bearRes = await fetch(DEFAULT_BEAR_URL, { cache: "force-cache" });
    if (!bearRes.ok) {
      throw new Error(`Could not load default-bear.jpg (${bearRes.status}).`);
    }
    const bearBlob = await bearRes.blob();
    imageBitmap = await createImageBitmap(bearBlob);

    setStatus("Running saliency on the sample image…");
    await runSaliency();
  } catch (e) {
    setStatus(String(e?.message || e), true);
    runBtn.disabled = true;
  }
}

init();
