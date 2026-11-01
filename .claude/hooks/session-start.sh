#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Point git at the husky hooks; the pre-commit hook installs its own deps
git -C "$CLAUDE_PROJECT_DIR" config core.hooksPath .husky
