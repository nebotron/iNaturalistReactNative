#!/usr/bin/env python3
"""
Read (and clear) the app_log the release build writes to Firebase.

Every logger line from a non-dev build is POSTed to {CROP_LOG_FIREBASE_URL}/app_log
by src/api/log/index.ts. Both reads and writes are unauthenticated; the
database is the one in firebase_auth.DEFAULT_FIREBASE_URL unless
CROP_LOG_FIREBASE_URL points this script at another one.

Usage:
    python3 scripts/app_log.py                  # grouped summary of recent entries
    python3 scripts/app_log.py --level error    # only errors (repeatable prefix match)
    python3 scripts/app_log.py --grep ui_hang   # only entries matching a regex
    python3 scripts/app_log.py --detail 3       # full entries behind summary group 3
    python3 scripts/app_log.py --dump app_log.json
    python3 scripts/app_log.py --clear          # delete every log except crop/brightness
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert( 0, str( Path( __file__ ).parent ) )

from firebase_auth import firebase_auth_query, firebase_base_url  # noqa: E402

REPO_ROOT = Path( __file__ ).parent.parent
ENV_FILE = REPO_ROOT / ".env"
# Training data, not diagnostics: never cleared.
KEEP_PATHS = { "crop_log", "brightness_log" }
DEFAULT_LIMIT = 3000


def load_env() -> None:
    if not ENV_FILE.is_file():
        return
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith( "#" ) or "=" not in line:
            continue
        k, _, v = line.partition( "=" )
        os.environ.setdefault( k.strip(), v.strip() )


def request( url: str, method: str = "GET" ) -> object:
    req = urllib.request.Request(
        url, method=method, headers={ "User-Agent": "iNat-app-log/1.0" }
    )
    with urllib.request.urlopen( req, timeout=30 ) as r:
        body = r.read()
    return json.loads( body ) if body else None


def db_url( base_url: str, path: str, **params: str ) -> str:
    auth = firebase_auth_query()
    query = [auth[1:]] if auth else []
    query += [f"{k}={v}" for k, v in params.items()]
    suffix = "?" + "&".join( query ) if query else ""
    return f"{base_url.rstrip('/')}/{path}{suffix}"


def fetch_entries( base_url: str, limit: int | None ) -> list[dict]:
    # Push IDs sort chronologically, so limitToLast on $key is "the most recent
    # N lines" and needs no index rule.
    params = {}
    if limit:
        params = {
            "orderBy": urllib.parse.quote( '"$key"' ),
            "limitToLast": str( limit ),
        }
    data = request( db_url( base_url, "app_log.json", **params ) )
    if isinstance( data, dict ):
        entries = [v for v in data.values() if isinstance( v, dict )]
    elif isinstance( data, list ):
        entries = [e for e in data if isinstance( e, dict )]
    else:
        entries = []
    entries.sort( key=lambda e: str( e.get( "timestamp", "" ) ) )
    return entries


# Collapse the varying parts of a message so repeats of the same log line group
# together however many ids, durations and URLs they carry.
def shape( message: str ) -> str:
    s = re.sub( r"https?://\S+", "<url>", message )
    s = re.sub( r"\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b", "<uuid>", s, flags=re.I )
    # No word boundaries: durations and sizes are written glued to their unit
    # ("8595ms"), and a trailing \b would leave every one of those distinct.
    s = re.sub( r"\d+(\.\d+)?", "<n>", s )
    return re.sub( r"\s+", " ", s ).strip()[:200]


def group( entries: list[dict] ) -> list[dict]:
    groups: dict[tuple, dict] = {}
    for e in entries:
        message = str( e.get( "message", "" ) )
        key = ( e.get( "level", "?" ), e.get( "extension", "?" ), shape( message ) )
        g = groups.setdefault( key, {
            "level": key[0], "extension": key[1], "shape": key[2],
            "count": 0, "first": None, "last": None,
            "commits": set(), "entries": [],
        } )
        g["count"] += 1
        ts = str( e.get( "timestamp", "" ) )
        g["first"] = min( g["first"] or ts, ts )
        g["last"] = max( g["last"] or ts, ts )
        if e.get( "commit" ):
            g["commits"].add( str( e["commit"] )[:9] )
        g["entries"].append( e )
    order = { "error": 0, "warn": 1, "info": 2, "debug": 3 }
    return sorted(
        groups.values(),
        key=lambda g: ( order.get( g["level"], 9 ), -g["count"] ),
    )


def print_summary( entries: list[dict], groups: list[dict] ) -> None:
    by_level: dict[str, int] = defaultdict( int )
    for e in entries:
        by_level[str( e.get( "level", "?" ) )] += 1
    span = f'{entries[0].get( "timestamp", "?" )} → {entries[-1].get( "timestamp", "?" )}'
    levels = ", ".join( f"{k}={v}" for k, v in sorted( by_level.items() ) )
    print( f"{len(entries)} entries ({levels})" )
    print( f"span: {span}\n" )
    print( f'{"#":>3}  {"n":>5}  {"level":<5}  {"extension":<28}  message' )
    for i, g in enumerate( groups ):
        print(
            f'{i:>3}  {g["count"]:>5}  {g["level"]:<5}  {str(g["extension"])[:28]:<28}  '
            f'{g["shape"][:110]}'
        )


def print_detail( groups: list[dict], index: int, limit: int ) -> None:
    if index < 0 or index >= len( groups ):
        sys.exit( f"No group {index} (have 0..{len(groups) - 1})." )
    g = groups[index]
    print( f'[{index}] {g["level"]} {g["extension"]} ×{g["count"]}' )
    print( f'first: {g["first"]}   last: {g["last"]}' )
    print( f'commits: {", ".join(sorted(g["commits"])) or "unknown"}\n' )
    for e in g["entries"][-limit:]:
        print( json.dumps( e, indent=2 ) )
        print()


def clear_logs( base_url: str ) -> None:
    root = request( db_url( base_url, ".json", shallow="true" ) )
    paths = sorted( root.keys() ) if isinstance( root, dict ) else []
    if not paths:
        print( "Nothing at the database root." )
        return
    for path in paths:
        if path in KEEP_PATHS:
            print( f"  keeping {path}" )
            continue
        request( db_url( base_url, f"{path}.json" ), method="DELETE" )
        print( f"  deleted {path}" )


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__ )
    parser.add_argument( "--limit", type=int, default=DEFAULT_LIMIT,
                         help=f"most recent N entries (default {DEFAULT_LIMIT}; 0 = all)" )
    parser.add_argument( "--level", action="append",
                         help="only this level (repeatable): error, warn, info, debug" )
    parser.add_argument( "--grep", help="only entries whose message or stack matches this regex" )
    parser.add_argument( "--detail", type=int, help="print full entries for a summary group" )
    parser.add_argument( "--detail-limit", type=int, default=5,
                         help="how many entries --detail prints (default 5)" )
    parser.add_argument( "--dump", help="write the fetched entries to this JSON file" )
    parser.add_argument( "--clear", action="store_true",
                         help="delete every Firebase log except the crop and brightness logs" )
    args = parser.parse_args()

    load_env()
    base_url = firebase_base_url()

    if args.clear:
        clear_logs( base_url )
        return

    entries = fetch_entries( base_url, args.limit or None )
    if args.level:
        wanted = { level.lower() for level in args.level }
        entries = [e for e in entries if str( e.get( "level", "" ) ).lower() in wanted]
    if args.grep:
        pattern = re.compile( args.grep, re.I )
        entries = [
            e for e in entries
            if pattern.search( f'{e.get("message", "")} {e.get("stack", "")}' )
        ]
    if not entries:
        print( "No matching entries." )
        return

    if args.dump:
        Path( args.dump ).write_text( json.dumps( entries, indent=2 ) + "\n" )
        print( f"Wrote {len(entries)} entries to {args.dump}." )

    groups = group( entries )
    if args.detail is not None:
        print_detail( groups, args.detail, args.detail_limit )
    else:
        print_summary( entries, groups )


if __name__ == "__main__":
    main()
