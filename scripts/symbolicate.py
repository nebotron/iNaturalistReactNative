#!/usr/bin/env python3
"""
Name the app's own frames in iOS crash logs and MetricKit stacks.

TestFlight builds go up without symbols, so crash logs and MetricKit stacks
give the app's own frames as bare offsets into the stripped binary. Symbols for
a build come from either workflow, as artifacts to unzip into DIR:
    symbols-<build>          saved by the TestFlight build (kept 90 days)
    rebuilt-symbols-<build>  rebuilt from the build's commit by ios-symbols.yml
    rebuilt-dsym-<build>     the rebuilt dSYM; with it (and llvm-symbolizer),
                             frames also get file, line and inlined callers

Usage:
    python3 scripts/symbolicate.py crash.ips              # a crash log: TestFlight's
                                                          # text or a device's .ips JSON
    python3 scripts/symbolicate.py --log                  # MetricKit stacks in the app log
    python3 scripts/symbolicate.py --log metrickit_hang   # only these
    python3 scripts/symbolicate.py --symbols DIR ...      # default scripts/.symbols

For a crash log Apple already symbolicated, each frame shows Apple's name next
to the rebuilt one and the run ends with how many agree, which is how to check
a rebuild. The binary's UUID is checked against the rebuild's uuid.txt.
"""

from __future__ import annotations

import argparse
import bisect
import functools
import gzip
import json
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert( 0, str( Path( __file__ ).parent ) )

APP_BINARY = "iNaturalistReactNative"
# Where an arm64 iOS executable's __TEXT segment starts. The symbol table's
# addresses include it; crash and MetricKit offsets are from the load address.
TEXT_BASE = 0x100000000
# MetricKit lines as AppDelegate.mm flattens them: "  <binary> [name+N ](+0xOFF)"
# or "  <binary>+0xOFF"
METRICKIT_FRAME = re.compile( rf"^(\s*){APP_BINARY}\b.*?\+0x([0-9a-f]+)\)?\s*$" )
TEXT_FRAME = re.compile( r"^(\d+)\s+(\S+)\s+0x([0-9a-f]+) (.*)$" )
TEXT_IMAGE = re.compile( r"^\s*0x([0-9a-f]+) -\s+0x[0-9a-f]+ (\S+) \S+\s+<([0-9a-f]+)>" )
APPLE_NAME = re.compile( r"^(.*?) \+ (\d+)(?: \(.*\))?$" )


class Symbols:
    """One build's function table, plus its dSYM when there is one."""

    def __init__( self, table: Path, dwarf: Path | None, uuid: str | None ):
        self.addresses: list[int] = []
        self.names: list[str] = []
        opener = gzip.open if table.suffix == ".gz" else open
        with opener( table, "rt", errors="replace" ) as f:
            for line in f:
                parts = line.rstrip( "\n" ).split( " ", 2 )
                if len( parts ) == 3 and parts[1] in ( "t", "T" ):
                    self.addresses.append( int( parts[0], 16 ) )
                    self.names.append( parts[2] )
        self.dwarf = dwarf if dwarf and shutil.which( "llvm-symbolizer" ) else None
        self.uuid = uuid

    def function( self, offset: int ) -> tuple[str, int] | None:
        """The function holding this offset, and the offset into it."""
        address = TEXT_BASE + offset
        i = bisect.bisect_right( self.addresses, address ) - 1
        return ( demangle( self.names[i] ), address - self.addresses[i] ) if i >= 0 else None

    def lines( self, offsets: list[int] ) -> list[list[str]]:
        """For each offset, its frames innermost first as "function (file:line)"."""
        if not self.dwarf or not offsets:
            return [[] for _ in offsets]
        # Addresses in the dSYM's own space, which starts at TEXT_BASE; the
        # default output style ends each address's frames with a blank line
        result = subprocess.run(
            ["llvm-symbolizer", f"--obj={self.dwarf}", "--inlines", "--demangle"],
            input="".join( f"0x{TEXT_BASE + o:x}\n" for o in offsets ),
            capture_output=True, text=True, check=True,
        )
        blocks, current = [], []
        for line in result.stdout.splitlines():
            if not line.strip():
                blocks.append( current )
                current = []
            else:
                current.append( line )
        blocks.append( current )
        out = []
        for block in blocks[:len( offsets )]:
            pairs = zip( block[0::2], block[1::2] )
            out.append( [f"{name} ({Path( where ).name})" for name, where in pairs
                         if name != "??"] )
        return out + [[] for _ in range( len( offsets ) - len( out ) )]


@functools.cache
def demangle( name: str ) -> str:
    """The table's name as Apple prints it: C symbols lose nm's leading
    underscore, and C++ names the CI's c++filt left mangled get demangled."""
    if name.startswith( "__Z" ):
        tool = shutil.which( "llvm-cxxfilt" ) or shutil.which( "c++filt" )
        if tool:
            out = subprocess.run( [tool, name[1:]], capture_output=True, text=True ).stdout
            return out.strip() or name
    if name.startswith( "_" ) and not name.startswith( "__" ):
        return name[1:]
    return name


def same_function( apple: str, ours: str ) -> bool:
    # Apple cuts long names short with "..."
    if apple.endswith( "..." ):
        return ours.startswith( apple[:-3] )
    return apple == ours


def find_symbols( directory: Path, build: str ) -> Symbols | None:
    table = None
    for folder in ( directory, directory / f"symbols-{build}",
                    directory / f"rebuilt-symbols-{build}" ):
        for name in ( f"{build}.txt.gz", f"{build}.txt" ):
            if ( folder / name ).exists():
                table = folder / name
                break
        if table:
            break
    if not table:
        return None
    uuid_file = table.parent / "uuid.txt"
    uuid = None
    if uuid_file.exists():
        match = re.search( r"UUID: ([0-9A-Fa-f-]+)", uuid_file.read_text() )
        uuid = match.group( 1 ).replace( "-", "" ).lower() if match else None
    return Symbols( table, find_dwarf( directory, build ), uuid )


def find_dwarf( directory: Path, build: str ) -> Path | None:
    folder = directory / f"rebuilt-dsym-{build}"
    archive = folder / "iNaturalistReactNative.app.dSYM.zip"
    if archive.exists() and not ( folder / "iNaturalistReactNative.app.dSYM" ).exists():
        with zipfile.ZipFile( archive ) as z:
            z.extractall( folder )
    dwarf = folder / "iNaturalistReactNative.app.dSYM/Contents/Resources/DWARF" / APP_BINARY
    return dwarf if dwarf.exists() else None


def parse_crash_log( text: str ) -> tuple[str | None, dict | None, list[dict]]:
    """The build, the app image (load address and UUID), and every frame."""
    first, _, rest = text.partition( "\n" )
    try:
        header, body = json.loads( first ), json.loads( rest )
    except json.JSONDecodeError:
        header = body = None
    if body and "threads" in body:
        images = body.get( "usedImages", [] )
        app = next( ( i for i in images if i.get( "name" ) == APP_BINARY ), None )
        frames = []
        for t, thread in enumerate( body["threads"] ):
            for n, frame in enumerate( thread.get( "frames", [] ) ):
                image = images[frame["imageIndex"]]
                frames.append( {
                    "thread": t, "index": n, "triggered": thread.get( "triggered", False ),
                    "image": image.get( "name" ), "offset": frame["imageOffset"],
                    "apple": frame.get( "symbol" ),
                    "apple_offset": frame.get( "symbolLocation" ),
                } )
        image = { "uuid": app["uuid"].replace( "-", "" ).lower() } if app else None
        return header.get( "build_version" ), image, frames

    build = re.search( r"^Version:\s+\S+ \(([\d.]+)\)", text, re.M )
    images = {}
    for line in text.split( "Binary Images:", 1 )[-1].splitlines():
        match = TEXT_IMAGE.match( line )
        if match:
            images[match.group( 2 )] = { "load": int( match.group( 1 ), 16 ),
                                         "uuid": match.group( 3 ).lower() }
    frames, thread, triggered = [], -1, False
    for line in text.split( "Binary Images:", 1 )[0].splitlines():
        heading = re.match( r"^Thread (\d+)( Crashed)?:", line )
        if heading:
            thread, triggered = int( heading.group( 1 ) ), bool( heading.group( 2 ) )
            continue
        match = TEXT_FRAME.match( line )
        if not match or match.group( 2 ) not in images:
            continue
        apple = APPLE_NAME.match( match.group( 4 ) )
        frames.append( {
            "thread": thread, "index": int( match.group( 1 ) ), "triggered": triggered,
            "image": match.group( 2 ),
            "offset": int( match.group( 3 ), 16 ) - images[match.group( 2 )]["load"],
            "apple": apple.group( 1 ) if apple else None,
            "apple_offset": int( apple.group( 2 ) ) if apple else None,
        } )
    return build.group( 1 ) if build else None, images.get( APP_BINARY ), frames


def lookup_offset( frame: dict ) -> int:
    # Every frame but a thread's first is a return address, which can fall just
    # past the end of a function that ends in a call
    return frame["offset"] - ( 1 if frame["index"] > 0 else 0 )


def symbolicate_crash_log( path: Path, directory: Path ) -> None:
    build, image, frames = parse_crash_log( path.read_text( errors="replace" ) )
    print( f"{path.name}: build {build}" )
    symbols = find_symbols( directory, build ) if build else None
    if not symbols:
        sys.exit( f"No symbols for build {build} in {directory}" )
    if image and symbols.uuid:
        same = image["uuid"] == symbols.uuid
        print( f"binary UUID {image['uuid']} "
               + ( "matches the rebuild" if same else f"!= the rebuild's {symbols.uuid}" ) )
    app_frames = [f for f in frames if f["image"] == APP_BINARY]
    lines = symbols.lines( [lookup_offset( f ) for f in app_frames] )
    # Apple lists inlined frames as extra lines at the same address, innermost
    # first; the table names only the outermost one
    outermost = {}
    for f in app_frames:
        outermost[( f["thread"], f["offset"] )] = f
    agree = checked = 0
    thread = None
    for f, where in zip( app_frames, lines ):
        if f["thread"] != thread:
            thread = f["thread"]
            print( f"\nthread {thread}{' (crashed)' if f['triggered'] else ''}" )
        found = symbols.function( lookup_offset( f ) )
        ours = f"{found[0]} + {found[1] + ( f['offset'] - lookup_offset( f ) )}" \
            if found else "?"
        mark = ""
        if f["apple"] and outermost[( f["thread"], f["offset"] )] is f:
            checked += 1
            if found and same_function( f["apple"], found[0] ) \
                    and f["apple_offset"] == found[1] + f["offset"] - lookup_offset( f ):
                agree += 1
                mark = "  = Apple"
            else:
                mark = f"  != Apple: {f['apple']} + {f['apple_offset']}"
        print( f"  {f['index']:>3} +0x{f['offset']:x}  {ours}{mark}" )
        # Once per address, after Apple's last line for it
        if outermost[( f["thread"], f["offset"] )] is f:
            for inline in where:
                print( f"          {inline}" )
    if checked:
        print( f"\n{agree} of {checked} frames Apple symbolicated agree with these symbols" )


def symbolicate_log( directory: Path, pattern: str, dump: Path | None ) -> None:
    if dump:
        entries = json.loads( dump.read_text() )
        entries = entries if isinstance( entries, list ) else list( entries.values() )
    else:
        from app_log import fetch_entries
        from firebase_auth import firebase_base_url, load_env
        load_env()
        entries = fetch_entries( firebase_base_url(), None )
    regex = re.compile( pattern )
    found = [e for e in entries if regex.search( str( e.get( "message", "" ) ) )
             and e.get( "stack" )]
    if not found:
        print( f"No entries matching {pattern} have a stack" )
    for e in found:
        build = e.get( "appBuild" )
        symbols = find_symbols( directory, build ) if build else None
        print( f"{e.get( 'timestamp', '' )[:19]}  {e['message']}  build {build}"
               + ( "" if symbols else "  (no symbols for this build)" ) )
        frames = [line for line in str( e["stack"] ).splitlines() if line.strip()]
        offsets = [METRICKIT_FRAME.match( line ) for line in frames]
        where = symbols.lines(
            [int( m.group( 2 ), 16 ) for m in offsets if m] ) if symbols else []
        where_iter = iter( where )
        for line, match in zip( frames, offsets ):
            if not symbols or not match:
                print( f"  {line.strip()}" )
                continue
            found = symbols.function( int( match.group( 2 ), 16 ) )
            inlines = next( where_iter, [] )
            print( f"  {APP_BINARY} {found[0]} + {found[1]}" if found else f"  {line.strip()}" )
            for inline in inlines[:-1]:
                print( f"      inlined: {inline}" )
            if inlines:
                print( f"      at {inlines[-1]}" )
        print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter )
    parser.add_argument( "crash_logs", nargs="*", type=Path )
    parser.add_argument( "--symbols", type=Path, default=Path( __file__ ).parent / ".symbols",
                         help="directory of unzipped symbol artifacts (default scripts/.symbols)" )
    parser.add_argument( "--log", nargs="?", const=r"^metrickit_", metavar="REGEX",
                         help="symbolicate app-log stacks whose message matches "
                              "(default all MetricKit ones)" )
    parser.add_argument( "--file", type=Path, help="an app_log.py --dump file instead of the log" )
    args = parser.parse_args()
    if not args.crash_logs and not args.log:
        parser.error( "give a crash log or --log" )
    for path in args.crash_logs:
        symbolicate_crash_log( path, args.symbols )
    if args.log:
        symbolicate_log( args.symbols, args.log, args.file )


if __name__ == "__main__":
    main()
