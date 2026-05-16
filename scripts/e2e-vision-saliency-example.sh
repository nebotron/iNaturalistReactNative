#!/usr/bin/env bash
# End-to-end check: run gradient saliency on the GitHub Pages demo bear image (Python path).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BEAR="${ROOT}/docs/inat-saliency-web/default-bear.jpg"
OUT="${TMPDIR:-/tmp}/e2e_vision_saliency_bear.png"
export PYTHONPATH="${ROOT}/tools/inat_vision_saliency${PYTHONPATH:+:${PYTHONPATH}}"

if [[ ! -f "$BEAR" ]]; then
  echo "Missing example image: $BEAR" >&2
  exit 1
fi

echo "==> Python saliency on example image: $BEAR"
python3 -m inat_vision_saliency "$BEAR" --download-model -o "$OUT"

if [[ ! -f "$OUT" ]]; then
  echo "Expected output PNG missing: $OUT" >&2
  exit 1
fi

python3 - << PY
from pathlib import Path
p = Path("${OUT}")
print("==> Wrote", p, "size", p.stat().st_size, "bytes")
PY
echo "E2E (Python) OK"
