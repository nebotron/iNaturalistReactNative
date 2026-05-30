#!/usr/bin/env bash
# Polls develop-squash every 20 seconds. On a new commit, runs `npr` and
# uploads the output as a GitHub Gist named npr_output_<hash>.txt.
# Requires GITHUB_TOKEN to be set.

set -euo pipefail

BRANCH="develop-squash"
POLL_INTERVAL=20
SEEN_HASH_FILE="${TMPDIR:-/tmp}/poll_develop_squash_seen_hash"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "ERROR: GITHUB_TOKEN is not set" >&2
  exit 1
fi

# Seed with the current tip so we don't re-run on startup
git fetch fork "$BRANCH" --quiet 2>/dev/null || true
git rev-parse "fork/$BRANCH" 2>/dev/null > "$SEEN_HASH_FILE" || echo "" > "$SEEN_HASH_FILE"

echo "Polling $BRANCH every ${POLL_INTERVAL}s …"

while true; do
  git fetch fork "$BRANCH"

  NEW_HASH="$(git rev-parse "fork/$BRANCH" 2>/dev/null || true)"
  SEEN_HASH="$(cat "$SEEN_HASH_FILE")"

  if [[ -z "$NEW_HASH" || "$NEW_HASH" == "$SEEN_HASH" ]]; then
    sleep "$POLL_INTERVAL"
    continue
  fi

  echo "$(date): new commit $NEW_HASH on $BRANCH — running npr"
  echo "$NEW_HASH" > "$SEEN_HASH_FILE"

  OUTPUT_FILE="$(mktemp)"

  # Run npr at the new commit in a subshell so detach/checkout is scoped
  (
    git checkout --quiet --detach "$NEW_HASH" 2>&1
    npr 2>&1
  ) > "$OUTPUT_FILE" 2>&1 || true

  GIST_FILENAME="npr_output_${NEW_HASH}.txt"

  PAYLOAD="$(python3 - "$OUTPUT_FILE" "$GIST_FILENAME" "$NEW_HASH" <<'PYEOF'
import json, sys

output_file, filename, commit_hash = sys.argv[1], sys.argv[2], sys.argv[3]
with open(output_file) as f:
    content = f.read()

body = {
    "description": f"npr output for commit {commit_hash}",
    "public": False,
    "files": {
        filename: {"content": content if content.strip() else "(empty output)"}
    },
}
print(json.dumps(body))
PYEOF
)"

  HTTP_RESPONSE="$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    https://api.github.com/gists)"

  HTTP_STATUS="$(echo "$HTTP_RESPONSE" | tail -n1)"

  if [[ "$HTTP_STATUS" == "201" ]]; then
    GIST_URL="$(echo "$HTTP_RESPONSE" | head -n-1 | python3 -c "import json,sys; print(json.load(sys.stdin).get('html_url',''))")"
    echo "$(date): gist created — $GIST_FILENAME  $GIST_URL"
  else
    echo "$(date): WARNING — gist creation returned HTTP $HTTP_STATUS" >&2
    echo "$HTTP_RESPONSE" | head -n-1 >&2
  fi

  rm -f "$OUTPUT_FILE"
done
