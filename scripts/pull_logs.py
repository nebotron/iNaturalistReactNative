#!/usr/bin/env python3
"""
Pull the crop log and brightness log from Firebase into the (gitignored)
crop_training.json and brightness_training.json files.

Reads firebase_auth.DEFAULT_FIREBASE_URL unless CROP_LOG_FIREBASE_URL is set
in .env or as an environment variable.

Usage:
    python3 scripts/pull_logs.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert( 0, str( Path( __file__ ).parent ) )

from firebase_auth import firebase_auth_query, firebase_base_url  # noqa: E402

REPO_ROOT = Path( __file__ ).parent.parent
CROP_LOG_PATH = REPO_ROOT / "crop_training.json"
BRIGHTNESS_LOG_PATH = REPO_ROOT / "brightness_training.json"
ENV_FILE = REPO_ROOT / ".env"


def load_env() -> None:
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith( "#" ) or "=" not in line:
            continue
        k, _, v = line.partition( "=" )
        os.environ.setdefault( k.strip(), v.strip() )


def fetch( base_url: str, path: str ) -> object:
    url = f"{base_url.rstrip('/')}/{path}{firebase_auth_query()}"
    req = urllib.request.Request( url, headers={ "User-Agent": "iNat-pull-logs/1.0" } )
    with urllib.request.urlopen( req, timeout=15 ) as r:
        return json.loads( r.read() )


def merge_by_url( existing: list, incoming: list ) -> list:
    by_url = { e["url"]: e for e in existing if "url" in e }
    for entry in incoming:
        if "url" in entry:
            by_url[entry["url"]] = entry
    return list( by_url.values() )


def pull_crop_log( base_url: str ) -> bool:
    print( "Fetching crop log …" )
    data = fetch( base_url, "crop_log.json" )
    if isinstance( data, dict ):
        # Url-keyed object (value carries the url): keep the values.
        incoming = [v for v in data.values() if isinstance( v, dict ) and "url" in v]
    elif isinstance( data, list ):
        incoming = [e for e in data if e]
    else:
        incoming = []
    print( f"  Got {len(incoming)} entries from Firebase." )

    existing: list = []
    if CROP_LOG_PATH.is_file():
        try:
            existing = json.loads( CROP_LOG_PATH.read_text() )
        except Exception:
            pass

    before = len( existing )
    merged = merge_by_url( existing, incoming )
    CROP_LOG_PATH.write_text( json.dumps( merged, indent=2 ) + "\n" )
    print( f"  crop_training.json: {before} → {len(merged)} entries." )
    return len( merged ) != before


def pull_brightness_log( base_url: str ) -> bool:
    print( "Fetching brightness log …" )
    data = fetch( base_url, "brightness_log.json" )

    if isinstance( data, list ):
        incoming = [e for e in data if e and "url" in e]
    elif isinstance( data, dict ):
        incoming = []
        for key, val in data.items():
            if isinstance( val, dict ) and "url" in val:
                # Url-keyed object (value carries the url).
                incoming.append( { "url": val["url"], "brightness": val.get( "brightness" ) } )
            elif key.startswith( "http" ):
                # Legacy { url: brightness } object.
                incoming.append( { "url": key, "brightness": val } )
    else:
        incoming = []
    print( f"  Got {len(incoming)} entries from Firebase." )

    existing: list = []
    if BRIGHTNESS_LOG_PATH.is_file():
        try:
            existing = json.loads( BRIGHTNESS_LOG_PATH.read_text() )
        except Exception:
            pass

    before = len( existing )
    merged = merge_by_url( existing, incoming )
    BRIGHTNESS_LOG_PATH.write_text( json.dumps( merged, indent=2 ) + "\n" )
    print( f"  brightness_training.json: {before} → {len(merged)} entries." )
    return len( merged ) != before


def main() -> None:
    load_env()
    base_url = firebase_base_url()

    changed = pull_crop_log( base_url )
    changed = pull_brightness_log( base_url ) or changed

    if not changed:
        print( "No new entries." )


if __name__ == "__main__":
    main()
