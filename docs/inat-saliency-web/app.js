/**
 * Browser saliency: TensorFlow.js GraphModel + tf.grad on softmax class probability.
 * Model input layout from converter: [1, 299, 3, 299] = transpose(NHWC, [0,2,3,1]).
 *
 * Requires global `tf` from @tensorflow/tfjs (see index.html).
 */

import { TURBO_LUT } from "./turbo_lut.js";

const MODEL_URL = new URL("./tfjs_model/model.json", import.meta.url).href;
const DEFAULT_BEAR_URL = new URL("./default-bear.jpg", import.meta.url).href;
const INPUT_KEY = "serving_default_input_1__0";
const OUTPUT_NODE = "Identity";

const H = 299;
const W = 299;
const C = 3;
const L = H * W * C;

const tf = /** @type {any} */ (window).tf;
if (!tf?.loadGraphModel) {
  const st = document.getElementById("status");
  if (st) {
    st.textContent = "TensorFlow.js failed to load.";
    st.classList.add("error");
  }
  throw new Error("tf missing");
}

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const runBtn = $("runBtn");
const imageFile = $("imageFile");
const outSection = $("outSection");
const inputCanvas = $("inputCanvas");
const overlayCanvas = $("overlayCanvas");
const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: true });
const overlayCtx = overlayCanvas.getContext("2d", { willReadFrequently: true });

let model = null;
let imageBitmap = null;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
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

/** Float32Array length L row-major NHWC RGB 0–255 */
function imageToNHWCFloat(bitmap) {
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

async function pickBackend() {
  try {
    await tf.setBackend("webgl");
  } catch {
    await tf.setBackend("cpu");
  }
  await tf.ready();
}

async function runSaliency() {
  if (!model || !imageBitmap) return;

  runBtn.disabled = true;
  outSection.hidden = false;
  inputCtx.drawImage(imageBitmap, 0, 0, W, H);

  const rgbFlat = imageToNHWCFloat(imageBitmap);
  const nhwc = tf.tensor4d(rgbFlat, [1, H, W, C]);
  const modelLayout = tf.transpose(nhwc, [0, 2, 3, 1]);
  nhwc.dispose();

  const xv = tf.variable(modelLayout);
  try {
    setStatus("Forward pass (top class)…");
    const classIndex = tf.tidy(() => {
      const probs = model.execute({ [INPUT_KEY]: xv }, OUTPUT_NODE);
      return probs.argMax(1).dataSync()[0];
    });

    setStatus(`Backprop: ∂ p(class ${classIndex}) / ∂ input pixels…`);
    const f = () => {
      const probs = model.execute({ [INPUT_KEY]: xv }, OUTPUT_NODE);
      return probs.slice([0, classIndex], [1, 1]).sum();
    };
    const g = tf.grad(f);
    const dXm = g(xv);
    const dNHWC = tf.transpose(dXm, [0, 2, 3, 1]);
    dXm.dispose();
    const magT = tf.mean(tf.abs(dNHWC), -1);
    dNHWC.dispose();
    const magSqueezed = tf.squeeze(magT, [0]);
    magT.dispose();
    const mag = Float32Array.from(magSqueezed.dataSync());
    magSqueezed.dispose();

    colorizeAndBlend(rgbFlat, mag, 0.55);
    const bbox = minimalSquareBbox(mag);
    if (bbox) drawBbox(bbox);

    setStatus(
      `Top class index: ${classIndex}\n`
        + "Saliency: gradient magnitude of the predicted softmax probability (mean |∂/∂R|, |∂/∂G|, |∂/∂B|) per pixel.\n"
        + (bbox ? `Salient square (inclusive): ${bbox.join(", ")}` : "No salient square (empty mask)."),
    );
  } catch (e) {
    setStatus(`Saliency failed: ${e?.message || e}`, true);
    throw e;
  } finally {
    xv.dispose();
    runBtn.disabled = false;
  }
}

imageFile.addEventListener("change", async () => {
  const f = imageFile.files?.[0];
  if (!f) return;
  try {
    imageBitmap = await createImageBitmap(f);
    setStatus("Running saliency…");
    await runSaliency();
  } catch (e) {
    imageBitmap = null;
    runBtn.disabled = true;
    setStatus(`Could not read image: ${e}`, true);
  }
});

runBtn.addEventListener("click", () => {
  runSaliency().catch(() => {});
});

async function init() {
  try {
    await pickBackend();
    setStatus(
      `Loading TensorFlow.js graph model (~82 MB, first visit may take a while)… (${tf.getBackend()})`,
    );
    model = await tf.loadGraphModel(MODEL_URL);

    setStatus("Loading default bear photo…");
    const bearRes = await fetch(DEFAULT_BEAR_URL, { cache: "force-cache" });
    if (!bearRes.ok) throw new Error(`default-bear.jpg HTTP ${bearRes.status}`);
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
