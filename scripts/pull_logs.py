#!/usr/bin/env python3
"""
Pull the crop log and brightness log from Firebase and persist them to git.

Set CROP_LOG_FIREBASE_URL in .env or as an environment variable.

Usage:
    python3 scripts/pull_logs.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

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
    url = f"{base_url.rstrip('/')}/{path}"
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
        # Push-keyed object from the appended Firebase log: keep the values.
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
                # Push-keyed object from the appended Firebase log.
                incoming.append( { "url": val["url"], "brightness": val.get( "brightness" ) } )
            elif key.startswith( "http" ):
                # Legacy { url: brightness } object.
                incoming.append( { "url": key, "brightness": val } )
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


def git_commit( changed_files: list[Path] ) -> None:
    rel = [str( f.relative_to( REPO_ROOT ) ) for f in changed_files]
    subprocess.run( ["git", "add", *rel], cwd=REPO_ROOT, check=True )
    msg = "Update training logs from Firebase\n\n" + "\n".join( f"- {r}" for r in rel )
    subprocess.run( ["git", "commit", "-m", msg], cwd=REPO_ROOT, check=True )
    print( "  Committed." )


def main() -> None:
    load_env()
    base_url = os.environ.get( "CROP_LOG_FIREBASE_URL", "" ).strip()
    if not base_url:
        sys.exit(
            "CROP_LOG_FIREBASE_URL is not set.\n"
            "Add it to .env or export it as an environment variable."
        )

    changed: list[Path] = []
    if pull_crop_log( base_url ):
        changed.append( CROP_LOG_PATH )
    if pull_brightness_log( base_url ):
        changed.append( BRIGHTNESS_LOG_PATH )

    if not changed:
        print( "No new entries — nothing to commit." )
        return

    git_commit( changed )


if __name__ == "__main__":
    main()
