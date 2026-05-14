#!/usr/bin/env bash
# Runs on EAS Build workers before npm install (see package.json eas-build-pre-install).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "eas-pre-install: creating .env from env.example (override with EAS env / secrets for real keys)"
  cp env.example .env
fi

if [[ ! -f android/app/google-services.json ]]; then
  echo "eas-pre-install: creating android/app/google-services.json from example (replace with real Firebase file via secret or artifact)"
  cp android/app/google-services.example.json android/app/google-services.json
fi

# --- iOS Firebase plist placeholders ---
for variant in production staging; do
  plist="ios/GoogleService-Info.${variant}.plist"
  if [[ ! -f "$plist" ]]; then
    echo "eas-pre-install: creating $plist from example"
    cp ios/GoogleService-Info.example.plist "$plist"
  fi
done

# --- Download iOS ML model files from GitHub releases ---
MODEL_BASE_URL="https://github.com/inaturalist/model-files/releases/download/v25.01.15"
CV_MODEL="INatVision_Small_2_fact256_8bit.mlmodel"
GEO_MODEL="INatGeomodel_Small_2_8bit.mlmodel"
TAXONOMY="taxonomy.json"

for file in "$CV_MODEL" "$GEO_MODEL" "$TAXONOMY"; do
  dest="ios/$file"
  if [[ ! -f "$dest" ]]; then
    echo "eas-pre-install: downloading $file ..."
    curl -fsSL -o "$dest" "$MODEL_BASE_URL/$file"
    echo "eas-pre-install: downloaded $dest ($(wc -c < "$dest") bytes)"
  fi
done
