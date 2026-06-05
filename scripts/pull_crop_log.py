#!/usr/bin/env python3
"""
Pull the latest animal crop log from the GitHub Gist and merge it into
crop_training.json.

Set CROP_LOG_GIST_ID (and optionally CROP_LOG_GITHUB_TOKEN for private
gists) in .env or as environment variables.

Usage:
    python3 scripts/pull_crop_log.py
    CROP_LOG_GIST_ID=abc123 python3 scripts/pull_crop_log.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path( __file__ ).parent.parent
CROP_LOG_PATH = REPO_ROOT / "crop_training.json"
ENV_FILE = REPO_ROOT / ".env"


def load_env() -> None:
    """Load KEY=VALUE pairs from .env into os.environ (no override)."""
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith( "#" ) or "=" not in line:
            continue
        k, _, v = line.partition( "=" )
        os.environ.setdefault( k.strip(), v.strip() )


def fetch_gist( gist_id: str, token: str | None ) -> list:
    url = f"https://api.github.com/gists/{gist_id}"
    headers = { "User-Agent": "iNat-crop-pull/1.0", "Accept": "application/json" }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request( url, headers=headers )
    with urllib.request.urlopen( req, timeout=15 ) as r:
        gist = json.loads( r.read() )
    files = gist.get( "files", {} )
    crop_file = files.get( "crop_training.json" )
    if not crop_file:
        sys.exit( "Gist does not contain a file named crop_training.json" )
    raw_url = crop_file["raw_url"]
    req2 = urllib.request.Request( raw_url, headers={ "User-Agent": "iNat-crop-pull/1.0" } )
    with urllib.request.urlopen( req2, timeout=15 ) as r:
        return json.loads( r.read() )


def merge( existing: list, incoming: list ) -> list:
    by_url = { e["url"]: e for e in existing if "url" in e }
    for entry in incoming:
        if "url" in entry:
            by_url[entry["url"]] = entry
    return list( by_url.values() )


def main() -> None:
    load_env()
    gist_id = os.environ.get( "CROP_LOG_GIST_ID", "" ).strip()
    token = os.environ.get( "CROP_LOG_GITHUB_TOKEN", "" ).strip() or None
    if not gist_id:
        sys.exit(
            "CROP_LOG_GIST_ID is not set.\n"
            "Add it to .env or export it as an environment variable."
        )

    print( f"Fetching gist {gist_id} …" )
    incoming = fetch_gist( gist_id, token )
    print( f"  Got {len(incoming)} entries from Gist." )

    existing: list = []
    if CROP_LOG_PATH.is_file():
        try:
            existing = json.loads( CROP_LOG_PATH.read_text() )
        except Exception:
            pass

    merged = merge( existing, incoming )
    CROP_LOG_PATH.write_text( json.dumps( merged, indent=2 ) )
    print( f"  crop_training.json updated — {len(merged)} total entries." )


if __name__ == "__main__":
    main()
