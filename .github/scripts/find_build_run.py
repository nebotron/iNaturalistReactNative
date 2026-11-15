#!/usr/bin/env python3
"""
Find the TestFlight workflow run that produced a build, and how it built it.

A TestFlight build number is the UTC time its run's "Set the build number"
step ran (YYYY.MMDD.HHMMSS), so the build is the run whose job ran that step
at that second. Prints, as GitHub Actions outputs (or plain lines without
GITHUB_OUTPUT):
    sha                    the commit the run built
    run_id, job_id         the run and the job that archived it
    prebuilt_react_native  "true"/"false", from the job's log, or "unknown"
                           once GitHub has expired the log
    runner_image           the runner image and version the job ran on
    xcode                  the Xcode it built with ("26.6 17F113"), when the log says
    symbols_artifact_id    the run's own symbols-<build> artifact, if it saved one

Usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo find_build_run.py BUILD
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

API = "https://api.github.com"
WORKFLOW = "testflight-ios.yml"
STEP = "Set the build number"


class NoRedirect( urllib.request.HTTPRedirectHandler ):
    def redirect_request( self, *args, **kwargs ):
        return None


def get( path: str, raw: bool = False ):
    url = path if path.startswith( "http" ) else API + path
    request = urllib.request.Request( url, headers={
        "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    } )
    try:
        with urllib.request.build_opener( NoRedirect ).open( request, timeout=60 ) as response:
            body = response.read()
    except urllib.error.HTTPError as e:
        if e.code not in ( 301, 302, 307 ):
            raise
        # Logs redirect to blob storage, which refuses the API token
        with urllib.request.urlopen( e.headers["Location"], timeout=120 ) as response:
            body = response.read()
    return body.decode( errors="replace" ) if raw else json.loads( body )


def parse_time( text: str ) -> datetime:
    return datetime.fromisoformat( text.replace( "Z", "+00:00" ) )


def main() -> None:
    build = sys.argv[1].strip()
    if not re.fullmatch( r"\d{4}\.\d{4}\.\d{6}", build ):
        sys.exit( f"{build!r} is not a TestFlight build number like 2026.1017.144045" )
    built_at = datetime.strptime( build, "%Y.%m%d.%H%M%S" ).replace( tzinfo=timezone.utc )
    repo = f"/repos/{os.environ['GITHUB_REPOSITORY']}"

    # The step runs a few minutes into the run; an Intel fallback can start
    # well after the run was created.
    window = f"{( built_at - timedelta( hours=4 ) ).isoformat()}..{built_at.isoformat()}"
    runs = get( f"{repo}/actions/workflows/{WORKFLOW}/runs?per_page=100"
                f"&created={window.replace( '+00:00', 'Z' )}" )["workflow_runs"]
    matches = []
    for run in runs:
        jobs = get( f"{repo}/actions/runs/{run['id']}/jobs?filter=all&per_page=100" )["jobs"]
        for job in jobs:
            for step in job.get( "steps" ) or []:
                if step["name"] != STEP or not step.get( "started_at" ):
                    continue
                start = parse_time( step["started_at"] ) - timedelta( seconds=1 )
                end = parse_time( step.get( "completed_at" ) or step["started_at"] ) \
                    + timedelta( seconds=1 )
                if start <= built_at <= end:
                    matches.append( ( run, job ) )
    if not matches:
        sys.exit( f"No {WORKFLOW} run set build number {build}" )
    if len( matches ) > 1:
        sys.exit( f"Several runs could have set {build}: "
                  + ", ".join( str( r["id"] ) for r, _ in matches ) )
    run, job = matches[0]

    prebuilt = "unknown"
    image = xcode = ""
    try:
        log = get( f"{repo}/actions/jobs/{job['id']}/logs", raw=True )
        # Expressions are substituted in the logged script, so the old
        # prebuilt_react_native input shows up as a literal true or false
        flag = re.search( r'if \[ "(true|false)" = "true" \]; then[^\n]*\n'
                          r'[^\n]*export RCT_USE_RN_DEP=1', log )
        prebuilt = flag.group( 1 ) if flag else (
            "false" if "pod install" in log else "unknown" )
        name = re.search( r"Image: (\S+)", log )
        version = re.search( r"Version: (\S+)", log )
        image = " ".join( m.group( 1 ) for m in ( name, version ) if m )
        # The TestFlight workflow keys ccache on `xcodebuild -version` and
        # prints the wrapper it wrote; older runs never printed it
        built_with = re.search( r"string:Xcode([\d.]+)Buildversion(\w+)", log )
        xcode = " ".join( built_with.groups() ) if built_with else ""
    except urllib.error.HTTPError as e:
        # A crash log from the build answers it: prebuilt React Native shows
        # up as React.framework among its Binary Images
        print( f"::warning::Couldn't read the job's log ({e.code}); pass prebuilt_react_native",
               file=sys.stderr )

    artifacts = get( f"{repo}/actions/runs/{run['id']}/artifacts?per_page=100" )["artifacts"]
    symbols = next( ( a for a in artifacts
                      if a["name"] == f"symbols-{build}" and not a["expired"] ), None )

    outputs = {
        "sha": run["head_sha"],
        "run_id": run["id"],
        "job_id": job["id"],
        "prebuilt_react_native": prebuilt,
        "runner_image": image,
        "xcode": xcode,
        "symbols_artifact_id": symbols["id"] if symbols else "",
    }
    lines = "".join( f"{k}={v}\n" for k, v in outputs.items() )
    if os.environ.get( "GITHUB_OUTPUT" ):
        with open( os.environ["GITHUB_OUTPUT"], "a" ) as f:
            f.write( lines )
    print( lines, end="" )


if __name__ == "__main__":
    main()
