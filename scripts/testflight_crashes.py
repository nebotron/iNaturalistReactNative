#!/usr/bin/env python3
"""
List the crashes TestFlight testers reported, and fetch their crash logs.

A crash report a tester sends from TestFlight lands in App Store Connect with
their comment, the build, device and iOS version, and (when the device uploaded
one) the crash log. This reads them with the App Store Connect API.

Credentials come from the environment or the repo's .env, under either the
names the cloud environment uses or the ones the TestFlight workflow uses:
    APPLE_APP_STORE_CONNECT_KEY_ID     or ASC_KEY_ID
    APPLE_APP_STORE_CONNECT_ISSUER_ID  or ASC_ISSUER_ID
    AUTHKEY_P8_CONTENTS                or ASC_KEY_BASE64
The key may be the .p8 file's PEM text, its base64 body alone, or the whole
file base64-encoded.

Usage:
    python3 scripts/testflight_crashes.py               # newest reports first
    python3 scripts/testflight_crashes.py --limit 5
    python3 scripts/testflight_crashes.py --log 1       # print report 1's crash log
    python3 scripts/testflight_crashes.py --save DIR    # write every crash log to DIR

Tester emails are left out of the output.

Not every report has a crash log: one appears only once the tester's device
uploads it, and a crash iOS wrote no crash report for (such as a jetsam
memory kill) never has one. MetricKit's view of those is in the app log:
    python3 scripts/app_log.py --grep metrickit_crash
"""

from __future__ import annotations

import argparse
import base64
import functools
import json
import os
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

sys.path.insert( 0, str( Path( __file__ ).parent ) )

from firebase_auth import load_env  # noqa: E402

API = "https://api.appstoreconnect.apple.com"
DEFAULT_BUNDLE_ID = "com.benhannel.inat.dev"


def env( *names: str ) -> str:
    for name in names:
        value = os.environ.get( name, "" ).strip()
        if value:
            return value
    sys.exit( f"Set {' or '.join( names )} (in the environment or .env)" )


def private_key() -> ec.EllipticCurvePrivateKey:
    raw = env( "AUTHKEY_P8_CONTENTS", "ASC_KEY_BASE64" ).replace( "\\n", "\n" )
    if "BEGIN" not in raw:
        decoded = base64.b64decode( raw + "=" * ( -len( raw ) % 4 ) )
        if b"BEGIN" in decoded:
            # The whole .p8 file, base64-encoded (the workflow's ASC_KEY_BASE64)
            raw = decoded.decode()
        else:
            # Only the PEM body
            raw = "-----BEGIN PRIVATE KEY-----\n" + "\n".join( textwrap.wrap( raw, 64 ) ) \
                + "\n-----END PRIVATE KEY-----\n"
    return serialization.load_pem_private_key( raw.encode(), password=None )


def b64url( data: bytes ) -> str:
    return base64.urlsafe_b64encode( data ).rstrip( b"=" ).decode()


@functools.cache
def token() -> str:
    # Good for 20 minutes, longer than any run
    now = int( time.time() )
    header = { "alg": "ES256", "kid": env( "APPLE_APP_STORE_CONNECT_KEY_ID", "ASC_KEY_ID" ),
               "typ": "JWT" }
    claims = { "iss": env( "APPLE_APP_STORE_CONNECT_ISSUER_ID", "ASC_ISSUER_ID" ),
               "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1" }
    signing_input = b64url( json.dumps( header ).encode() ) + "." \
        + b64url( json.dumps( claims ).encode() )
    # ES256 wants the raw 64-byte r||s, not the DER signature
    r, s = decode_dss_signature(
        private_key().sign( signing_input.encode(), ec.ECDSA( hashes.SHA256() ) ),
    )
    signature = r.to_bytes( 32, "big" ) + s.to_bytes( 32, "big" )
    return signing_input + "." + b64url( signature )


def get( path: str, params: dict | None = None ) -> dict | None:
    """GET an API path; None when the resource doesn't exist."""
    url = path if path.startswith( "http" ) else API + path
    if params:
        url += "?" + urllib.parse.urlencode( params )
    request = urllib.request.Request( url, headers={ "Authorization": f"Bearer {token()}" } )
    try:
        with urllib.request.urlopen( request, timeout=60 ) as response:
            return json.loads( response.read() )
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        sys.exit( f"App Store Connect returned {e.code} for {path}: {e.read().decode()[:500]}" )


def app_id( bundle_id: str ) -> str:
    apps = get( "/v1/apps", { "filter[bundleId]": bundle_id, "fields[apps]": "name" } )
    if not apps or not apps["data"]:
        sys.exit( f"No app with bundle ID {bundle_id} in this App Store Connect account" )
    return apps["data"][0]["id"]


def crash_reports( app: str, limit: int ) -> list[dict]:
    response = get( f"/v1/apps/{app}/betaFeedbackCrashSubmissions", {
        "limit": min( limit, 200 ),
        "sort": "-createdDate",
        "include": "build",
        "fields[builds]": "version",
    } )
    versions = { b["id"]: b["attributes"]["version"] for b in response.get( "included", [] ) }
    reports = []
    for item in response["data"][:limit]:
        build = ( item["relationships"].get( "build" ) or {} ).get( "data" ) or {}
        reports.append( {
            "id": item["id"],
            "build": versions.get( build.get( "id" ), "?" ),
            **{ k: v for k, v in item["attributes"].items() if k != "email" },
        } )
    return reports


def crash_log( report_id: str ) -> str | None:
    response = get( f"/v1/betaFeedbackCrashSubmissions/{report_id}/crashLog" )
    if not response:
        return None
    return response["data"]["attributes"].get( "logText" )


def summarize_log( text: str ) -> str:
    keys = ( "Exception Type:", "Termination Reason:", "Triggered by Thread:" )
    lines = [line.strip() for line in text.splitlines() if line.startswith( keys )]
    return "; ".join( lines )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument( "--bundle-id", default=DEFAULT_BUNDLE_ID )
    parser.add_argument( "--limit", type=int, default=50, help="newest N reports (default 50)" )
    parser.add_argument( "--log", type=int, metavar="N", help="print report N's crash log" )
    parser.add_argument( "--save", type=Path, metavar="DIR", help="write each crash log to DIR" )
    args = parser.parse_args()

    load_env()
    reports = crash_reports( app_id( args.bundle_id ), args.limit )

    if args.log is not None:
        if not 0 <= args.log < len( reports ):
            sys.exit( f"No report {args.log}; there are {len( reports )}" )
        text = crash_log( reports[args.log]["id"] )
        print( text if text else "This report has no crash log." )
        return

    for report in reports:
        report["crashLog"] = crash_log( report["id"] )

    if args.save:
        args.save.mkdir( parents=True, exist_ok=True )
    print( f"{len( reports )} TestFlight crash reports, newest first\n" )
    for n, report in enumerate( reports ):
        text = report["crashLog"]
        print( f"[{n}] {report['createdDate'][:16].replace( 'T', ' ' )}  "
               f"build {report['build']}  iOS {report['osVersion']}  {report['deviceModel']}  "
               f"up {( report.get( 'appUptimeInMilliseconds' ) or 0 ) / 1000:.0f} s" )
        if report.get( "comment" ):
            print( f"    \"{report['comment'].strip()}\"" )
        print( f"    {summarize_log( text ) if text else 'no crash log'}" )
        if text and args.save:
            path = args.save / f"{report['createdDate'][:10]}_{report['build']}_{report['id']}.ips"
            path.write_text( text )
            print( f"    saved {path}" )


if __name__ == "__main__":
    main()
