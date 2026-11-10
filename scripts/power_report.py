#!/usr/bin/env python3
"""Summarize the app's battery use from the MetricKit entries in the app log.

AppDelegate.mm posts, once a day per iOS device:
  metrickit_daily                 totals: CPU, GPU, location, network, disk writes
  metrickit_signpost              the same split by screen and activity
                                  (ios/iNaturalistReactNative/PowerProfile.h)
and, when iOS flags them:
  metrickit_cpu_exception         a minute or more of heavy CPU, with its stack
  metrickit_disk_write_exception  over 1 GB written in a day, with its stack

Usage:
  python3 scripts/power_report.py                # everything in the log
  python3 scripts/power_report.py --days 7       # payloads from the last week
  python3 scripts/power_report.py --file log.json  # an app_log.py --dump file
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert( 0, str( Path( __file__ ).parent ) )

from app_log import fetch_entries  # noqa: E402
from firebase_auth import firebase_base_url, load_env  # noqa: E402

DAILY_COLUMNS = [
    ( "foregroundSeconds", "fg h", 3600 ),
    ( "backgroundSeconds", "bg h", 3600 ),
    ( "backgroundAudioSeconds", "bgAudio h", 3600 ),
    ( "cpuSeconds", "cpu h", 3600 ),
    ( "gpuSeconds", "gpu h", 3600 ),
    ( "location10mSeconds", "loc10m h", 3600 ),
    ( "location100mSeconds", "loc100m h", 3600 ),
    ( "locationBestSeconds", "locBest h", 3600 ),
    ( "diskWritesMB", "disk GB", 1024 ),
    ( "wifiDownMB", "wifiDn GB", 1024 ),
    ( "cellDownMB", "cellDn GB", 1024 ),
    ( "cellUpMB", "cellUp MB", 1 ),
    ( "peakMemoryMB", "peakMem MB", 1 ),
    # Kills at iOS's memory limit, which leave no crash report
    ( "fgMemoryLimitExits", "fgMemKill", 1 ),
    ( "bgMemoryLimitExits", "bgMemKill", 1 ),
]


def number( entry: dict, key: str ) -> float | None:
    value = entry.get( key )
    return value if isinstance( value, ( int, float ) ) and value >= 0 else None


def payload_start( entry: dict ) -> datetime | None:
    try:
        return datetime.strptime( entry.get( "from", "" ), "%Y-%m-%d %H:%M:%S %z" )
    except ValueError:
        return None


def print_daily( entries: list[dict] ) -> None:
    print( "Daily totals (one row per device per day; cpu/gpu % are of foreground time)" )
    header = ["day", "build"] + [label for _, label, _ in DAILY_COLUMNS] + ["cpu%", "gpu%"]
    print( "  ".join( f"{h:>10}" for h in header ) )
    for e in entries:
        values = [number( e, key ) for key, _, _ in DAILY_COLUMNS]
        if all( v is None for v in values ):
            continue
        fg, cpu, gpu = ( number( e, k ) for k in ( "foregroundSeconds", "cpuSeconds", "gpuSeconds" ) )
        row = [e.get( "from", "" )[:10], str( e.get( "appBuild", "" ) )[-11:]]
        row += [
            "-" if v is None else f"{v / scale:.2f}"
            for v, ( _, _, scale ) in zip( values, DAILY_COLUMNS )
        ]
        row += [
            f"{100 * x / fg:.0f}" if fg and x is not None else "-"
            for x in ( cpu, gpu )
        ]
        print( "  ".join( f"{c:>10}" for c in row ) )
    print()


def print_signposts( entries: list[dict] ) -> None:
    if not entries:
        print( "No metrickit_signpost entries yet: they arrive with the first daily payload "
               "from a build that includes PowerProfile.\n" )
        return
    totals: dict[str, dict[str, float]] = defaultdict( lambda: defaultdict( float ) )
    for e in entries:
        t = totals[e.get( "category", "?" )]
        t["count"] += number( e, "count" ) or 0
        for key in ( "seconds", "cpuSeconds", "diskWritesMB" ):
            t[key] += number( e, key ) or 0
        hitch, seconds = number( e, "hitchMsPerSecond" ), number( e, "seconds" )
        if hitch is not None and seconds:
            t["hitchMs"] += hitch * seconds
            t["hitchSeconds"] += seconds
    print( "By screen and activity (process-wide figures while each was open; "
           "activities overlap screens)" )
    header = ["category", "visits", "hours", "cpu h", "cpu%", "disk GB", "MB/min", "hitch ms/s"]
    print( f"{header[0]:<32}" + "".join( f"{h:>11}" for h in header[1:] ) )
    for category, t in sorted( totals.items(), key=lambda kv: -kv[1]["cpuSeconds"] ):
        seconds = t["seconds"]
        row = [
            f"{t['count']:.0f}",
            f"{seconds / 3600:.2f}",
            f"{t['cpuSeconds'] / 3600:.2f}",
            f"{100 * t['cpuSeconds'] / seconds:.0f}" if seconds else "-",
            f"{t['diskWritesMB'] / 1024:.2f}",
            f"{t['diskWritesMB'] / ( seconds / 60 ):.1f}" if seconds else "-",
            f"{t['hitchMs'] / t['hitchSeconds']:.1f}" if t["hitchSeconds"] else "-",
        ]
        print( f"{category[:32]:<32}" + "".join( f"{c:>11}" for c in row ) )
    print()


def print_exceptions( entries: list[dict], message: str, amount: str, unit: str ) -> None:
    found = [e for e in entries if e.get( "message" ) == message]
    print( f"{message}: {len( found )}" )
    for e in found[-5:]:
        print( f"  {e.get( 'from', '' )[:16]} build {e.get( 'appBuild' )} "
               f"{e.get( amount )} {unit}" )
        frames = [line for line in str( e.get( "stack", "" ) ).splitlines() if line.strip()]
        for line in frames[:12]:
            print( f"    {line}" )
    print()


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter )
    parser.add_argument( "--days", type=int, help="only payloads that start in the last N days" )
    parser.add_argument( "--file", help="read entries from an app_log.py --dump file" )
    args = parser.parse_args()

    if args.file:
        entries = json.loads( Path( args.file ).read_text() )
    else:
        load_env()
        entries = fetch_entries( firebase_base_url(), None )
    entries = [e for e in entries if e.get( "extension" ) == "MetricKit"]
    if args.days:
        since = datetime.now( timezone.utc ) - timedelta( days=args.days )
        entries = [e for e in entries if ( payload_start( e ) or since ) >= since]
    entries.sort( key=lambda e: e.get( "from", "" ) )

    print_daily( [e for e in entries if e.get( "message" ) == "metrickit_daily"] )
    print_signposts( [e for e in entries if e.get( "message" ) == "metrickit_signpost"] )
    print_exceptions( entries, "metrickit_disk_write_exception", "writesMB", "MB" )
    print_exceptions( entries, "metrickit_cpu_exception", "cpuSeconds", "CPU s" )


if __name__ == "__main__":
    main()
