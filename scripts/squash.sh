#!/usr/bin/env bash
# Squashes all commits on the current branch since its merge base with
# <remote>/main into a single commit, embedding the full original commit
# history in the squashed commit's body, then force-pushes (with lease)
# the branch back to <remote>. Pass --no-push to skip the push.

set -euo pipefail

PUSH=true
REMOTE=""
for arg in "$@"; do
  case "$arg" in
    --no-push) PUSH=false ;;
    *) REMOTE="$arg" ;;
  esac
done
REMOTE="${REMOTE:-fork}"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git fetch "$REMOTE" main

BASE="$(git merge-base "$REMOTE/main" HEAD)"
if [[ -z "$BASE" ]]; then
  echo "Error: no merge base with $REMOTE/main." >&2
  exit 1
fi

if [[ "$BASE" == "$(git rev-parse HEAD)" ]]; then
  echo "Nothing to squash: $BRANCH is at $REMOTE/main's merge base." >&2
  exit 1
fi

HISTORY="$(git log --reverse --format='%h %s' "$BASE"..HEAD)"

git reset --soft "$BASE"
git add -A
git commit -m "Squashed changes" -m "$HISTORY"

if [[ "$PUSH" == true ]]; then
  git push --force-with-lease "$REMOTE" "$BRANCH"
fi
