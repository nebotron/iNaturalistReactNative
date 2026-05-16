#!/usr/bin/env bash
# Rebuild docs/inat-saliency-web/tfjs_model/ for the in-browser saliency page (TensorFlow.js + tf.grad).
# Requires: Python onnx2tf, TensorFlow, tensorflowjs_converter (see INTEGRATION.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ONNX="${1:-$ROOT/tools/inat_vision_saliency/.cache/inat_vision_dequant.onnx}"
OUT="${2:-$ROOT/docs/inat-saliency-web/tfjs_model}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ ! -f "$ONNX" ]]; then
  echo "Missing ONNX: $ONNX" >&2
  echo "Build it first (e.g. npm run vision-saliency -- --help and run once with --download-model)." >&2
  exit 1
fi

echo "==> onnx2tf SavedModel -> $TMP/sm"
python3 -m onnx2tf -i "$ONNX" -o "$TMP/sm" -tb tf_converter

echo "==> tensorflowjs_converter -> $OUT"
rm -rf "$OUT"
mkdir -p "$OUT"
python3 -m tensorflowjs.converters.converter \
  --input_format=tf_saved_model \
  --output_format=tfjs_graph_model \
  --signature_name=serving_default \
  --saved_model_tags=serve \
  "$TMP/sm" \
  "$OUT"

echo "Done: $OUT"
