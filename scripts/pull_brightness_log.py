#!/usr/bin/env python3
"""
Pull the latest brightness label log from Firebase Realtime Database and save
it as brightness_training.json.

Set CROP_LOG_FIREBASE_URL in .env or as an environment variable (the brightness
log lives in the same Firebase project at /brightness_log.json).

Usage:
    python3 scripts/pull_brightness_log.py
    CROP_LOG_FIREBASE_URL=https://project.firebaseio.com python3 scripts/pull_brightness_log.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path( __file__ ).parent.parent
OUT_PATH   = REPO_ROOT / "brightness_training.json"
ENV_FILE   = REPO_ROOT / ".env"


def load_env() -> None:
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith( "#" ) or "=" not in line:
            continue
        k, _, v = line.partition( "=" )
        os.environ.setdefault( k.strip(), v.strip() )


def fetch_firebase( base_url: str ) -> list:
    url = f"{base_url.rstrip('/')}/brightness_log.json"
    req = urllib.request.Request( url, headers={ "User-Agent": "iNat-brightness-pull/1.0" } )
    with urllib.request.urlopen( req, timeout=15 ) as r:
        data = json.loads( r.read() )
    if data is None:
        return []
    if isinstance( data, list ):
        return [e for e in data if isinstance( e, dict ) and "url" in e and "brightness" in e]
    if isinstance( data, dict ):
        return [{"url": url, "brightness": b} for url, b in data.items()]
    return []


def merge( existing: list, incoming: list ) -> list:
    by_url = { e["url"]: e for e in existing if "url" in e }
    for entry in incoming:
        if "url" in entry:
            by_url[entry["url"]] = entry
    return list( by_url.values() )


def main() -> None:
    load_env()
    base_url = os.environ.get( "CROP_LOG_FIREBASE_URL", "" ).strip()
    if not base_url:
        sys.exit(
            "CROP_LOG_FIREBASE_URL is not set.\n"
            "Add it to .env or export it as an environment variable."
        )

    print( f"Fetching brightness log from {base_url} …" )
    incoming = fetch_firebase( base_url )
    print( f"  Got {len(incoming)} entries from Firebase." )

    existing: list = []
    if OUT_PATH.is_file():
        try:
            existing = json.loads( OUT_PATH.read_text() )
        except Exception:
            pass

    merged = merge( existing, incoming )
    OUT_PATH.write_text( json.dumps( merged, indent=2 ) )
    print( f"  brightness_training.json updated — {len(merged)} total entries." )


if __name__ == "__main__":
    main()
