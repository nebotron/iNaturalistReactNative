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
