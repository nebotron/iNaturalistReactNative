#!/usr/bin/env bash
# Lists all branches on the "fork" remote and, for each, the commits since
# its merge base with fork/main (i.e. what's unique to that branch).

set -euo pipefail

REMOTE="${1:-fork}"
BASE="$REMOTE/main"

git fetch --prune "$REMOTE"

branches="$(git for-each-ref --sort=-committerdate refs/remotes/$REMOTE/ --format='%(committerdate:short) %(refname:short)' | awk -v d=$(date -v-1d +%Y-%m-%d) '$1 >= d {print $2}')"

if [[ -z "$branches" ]]; then
  echo "No branches found on remote '$REMOTE'."
  exit 0
fi

while IFS= read -r ref; do
  merge_base="$(git merge-base "$BASE" "$ref" 2>/dev/null || true)"
  [[ -z "$merge_base" ]] && continue
  commits="$(git log --oneline "$merge_base..$ref" 2>/dev/null || true)"
  if [[ -n "$commits" ]]; then
    echo "=== $ref ==="
    echo "$commits"
    echo
  fi
done <<< "$branches"
