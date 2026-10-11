#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# Installs deps; postinstall runs husky, which wires up the pre-commit hook
npm install --no-audit --no-fund
# Pre-fetch lint-staged, which the pre-commit hook runs via npx
npx --yes lint-staged --version
