#!/usr/bin/env python3
"""
Pull the latest animal crop log from Firebase Realtime Database and merge it
into crop_training.json.

Requires these set in .env or as environment variables:
    CROP_LOG_FIREBASE_URL
    FIREBASE_WEB_API_KEY
    CLAUDE_FIREBASE_EMAIL
    CLAUDE_FIREBASE_PASSWORD

Usage:
    python3 scripts/pull_crop_log.py
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
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith( "#" ) or "=" not in line:
            continue
        k, _, v = line.partition( "=" )
        os.environ.setdefault( k.strip(), v.strip() )


def sign_in() -> str:
    api_key = os.environ.get( "FIREBASE_WEB_API_KEY", "" ).strip()
    email = os.environ.get( "CLAUDE_FIREBASE_EMAIL", "" ).strip()
    password = os.environ.get( "CLAUDE_FIREBASE_PASSWORD", "" ).strip()
    if not ( api_key and email and password ):
        sys.exit(
            "FIREBASE_WEB_API_KEY, CLAUDE_FIREBASE_EMAIL, and CLAUDE_FIREBASE_PASSWORD "
            "must be set (in .env or the environment) to read from Firebase."
        )
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={api_key}"
    body = json.dumps( {
        "email": email,
        "password": password,
        "returnSecureToken": True,
    } ).encode()
    req = urllib.request.Request(
        url, data=body, headers={ "Content-Type": "application/json" }, method="POST"
    )
    with urllib.request.urlopen( req, timeout=15 ) as r:
        return json.loads( r.read() )["idToken"]


def fetch_firebase( base_url: str, id_token: str ) -> list:
    url = f"{base_url.rstrip('/')}/crop_log.json?auth={id_token}"
    req = urllib.request.Request( url, headers={ "User-Agent": "iNat-crop-pull/1.0" } )
    with urllib.request.urlopen( req, timeout=15 ) as r:
        data = json.loads( r.read() )
    if data is None:
        return []
    return data


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

    id_token = sign_in()

    print( f"Fetching crop log from {base_url} …" )
    incoming = fetch_firebase( base_url, id_token )
    print( f"  Got {len(incoming)} entries from Firebase." )

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
