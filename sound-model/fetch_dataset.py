"""Build a labeled audio dataset from the iNaturalist API.

Picks the most-recorded species under a parent taxon, then downloads
research-grade observation audio for each. Only openly licensed sound files are
kept so the resulting dataset can be redistributed and reused.

Example:
    python3 fetch_dataset.py --taxon-id 3 --place-id 1 \
        --num-species 12 --per-species 200
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from common import AUDIO, DATA

API = "https://api.inaturalist.org/v1"
# iNaturalist asks for a descriptive user agent and no more than ~60 API
# requests/minute. Audio files come from a CDN rather than the API, so they get
# a lighter throttle.
USER_AGENT = "inat-sound-model/0.1 (research prototype; +https://github.com/inaturalist)"
API_INTERVAL = 1.05
FILE_INTERVAL = 0.2
OPEN_LICENSES = "cc0,cc-by,cc-by-nc,cc-by-sa,cc-by-nc-sa"

_last_request: dict[str, float] = { "api": 0.0, "file": 0.0 }


def _throttle( kind: str, interval: float ) -> None:
    wait = interval - ( time.monotonic() - _last_request[kind] )
    if wait > 0:
        time.sleep( wait )
    _last_request[kind] = time.monotonic()


def api_get( path: str, **params ) -> dict:
    """GET a JSON endpoint, retrying on transient failures."""
    url = f"{API}/{path}?{urllib.parse.urlencode( params )}"
    for attempt in range( 5 ):
        _throttle( "api", API_INTERVAL )
        try:
            req = urllib.request.Request( url, headers={ "User-Agent": USER_AGENT } )
            with urllib.request.urlopen( req, timeout=60 ) as resp:
                return json.load( resp )
        except ( urllib.error.URLError, TimeoutError, json.JSONDecodeError ) as err:
            if attempt == 4:
                raise
            print( f"  retry {attempt + 1} after {err}", file=sys.stderr )
            time.sleep( 2 ** attempt )
    raise RuntimeError( "unreachable" )


def top_species( taxon_id: int, num_species: int, place_id: int | None ) -> list[dict]:
    """Species with the most research-grade sound observations under a taxon."""
    params = {
        "sounds": "true",
        "quality_grade": "research",
        "taxon_id": taxon_id,
        "sound_license": OPEN_LICENSES,
        "rank": "species",
        "per_page": num_species,
    }
    if place_id:
        params["place_id"] = place_id
    results = api_get( "observations/species_counts", **params )["results"]
    return [
        {
            "taxon_id": r["taxon"]["id"],
            "name": r["taxon"]["name"],
            "common_name": r["taxon"].get( "preferred_common_name" ) or "",
            "count": r["count"],
        }
        for r in results
    ]


def max_observation_id() -> int:
    """Newest observation id, used as the upper bound when sampling over time."""
    results = api_get( "observations", order_by="id", order="desc", per_page=1 )["results"]
    return results[0]["id"] if results else 250_000_000


def observations_for_species(
    taxon_id: int, limit: int, place_id: int | None, max_id: int, seed: int
) -> list[dict]:
    """Sample observations with sounds, spread across the observation id range.

    The API caps page * per_page at 10,000, so cursoring on id is the only way
    to walk a large result set. Cursoring from zero would return only the oldest
    records for the species, which skews toward early adopters and dated
    recording gear, so instead we stratify the id range and take one page from a
    random point in each stratum. Observation ids increase monotonically with
    time, so this samples the species evenly across its whole upload history.
    """
    rows: list[dict] = []
    seen: set[int] = set()
    page_size = 200
    n_strata = max( 1, -( -limit // page_size ) )
    rng = random.Random( f"{seed}:{taxon_id}" )
    stride = max_id / n_strata
    cursors = [
        int( i * stride + rng.random() * stride * 0.9 ) for i in range( n_strata )
    ]

    for start in cursors:
        id_above = start
        # Each stratum contributes at most one page; if it is exhausted early we
        # simply move on to the next one.
        for _ in range( 2 ):
            if len( rows ) >= limit:
                break
            page = _observation_page( taxon_id, place_id, id_above, page_size )
            if not page:
                break
            id_above = page[-1]["id"]
            for obs in page:
                row = _row_from_observation( obs )
                if row and row["observation_id"] not in seen:
                    seen.add( row["observation_id"] )
                    rows.append( row )
                if len( rows ) >= limit:
                    break
    return rows


def _row_from_observation( obs: dict ) -> dict | None:
    sounds = [
        s for s in obs.get( "sounds", [] )
        if s.get( "file_url" ) and s.get( "license_code" )
    ]
    if not sounds or not obs.get( "taxon" ) or not obs.get( "user" ):
        return None
    # One sound per observation keeps the label-to-audio mapping 1:1 and stops
    # prolific multi-file observations from dominating a class.
    sound = sounds[0]
    return {
        "observation_id": obs["id"],
        "user_id": obs["user"]["id"],
        "taxon_id": obs["taxon"]["id"],
        "scientific_name": obs["taxon"]["name"],
        "sound_id": sound["id"],
        "file_url": sound["file_url"],
        "license_code": sound["license_code"],
    }


def _observation_page(
    taxon_id: int, place_id: int | None, id_above: int, page_size: int
) -> list[dict]:
    params = {
        "sounds": "true",
        "quality_grade": "research",
        "taxon_id": taxon_id,
        "sound_license": OPEN_LICENSES,
        "rank": "species",
        "order_by": "id",
        "order": "asc",
        "id_above": id_above,
        "per_page": page_size,
    }
    if place_id:
        params["place_id"] = place_id
    return api_get( "observations", **params )["results"]


def download( url: str, dest: pathlib.Path ) -> bool:
    if dest.exists() and dest.stat().st_size > 0:
        return True
    for attempt in range( 3 ):
        _throttle( "file", FILE_INTERVAL )
        try:
            req = urllib.request.Request( url, headers={ "User-Agent": USER_AGENT } )
            with urllib.request.urlopen( req, timeout=120 ) as resp:
                body = resp.read()
            if not body:
                return False
            dest.write_bytes( body )
            return True
        except ( urllib.error.URLError, TimeoutError ) as err:
            if attempt == 2:
                print( f"  failed {url}: {err}", file=sys.stderr )
                return False
            time.sleep( 2 ** attempt )
    return False


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__ )
    parser.add_argument( "--taxon-id", type=int, default=3, help="parent taxon (3 = Aves)" )
    parser.add_argument( "--place-id", type=int, default=None, help="restrict to a place" )
    parser.add_argument( "--num-species", type=int, default=12 )
    parser.add_argument( "--per-species", type=int, default=200 )
    parser.add_argument( "--seed", type=int, default=0 )
    args = parser.parse_args()

    DATA.mkdir( parents=True, exist_ok=True )
    AUDIO.mkdir( parents=True, exist_ok=True )

    species = top_species( args.taxon_id, args.num_species, args.place_id )
    print( f"Selected {len( species )} species:" )
    for s in species:
        print( f"  {s['name']:<32} {s['common_name']:<28} {s['count']:>7} obs" )

    max_id = max_observation_id()
    manifest: list[dict] = []
    for s in species:
        rows = observations_for_species(
            s["taxon_id"], args.per_species, args.place_id, max_id, args.seed
        )
        kept = 0
        for row in rows:
            ext = pathlib.Path( urllib.parse.urlparse( row["file_url"] ).path ).suffix or ".mp3"
            dest = AUDIO / f"{row['sound_id']}{ext}"
            if download( row["file_url"], dest ):
                row["path"] = str( dest.relative_to( DATA ) )
                row["common_name"] = s["common_name"]
                manifest.append( row )
                kept += 1
        print( f"{s['name']}: {kept}/{len( rows )} files" )

    out = DATA / "manifest.csv"
    with out.open( "w", newline="" ) as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "observation_id", "user_id", "taxon_id", "scientific_name",
                "common_name", "sound_id", "license_code", "file_url", "path",
            ],
        )
        writer.writeheader()
        writer.writerows( manifest )
    print( f"\nWrote {len( manifest )} rows to {out}" )


if __name__ == "__main__":
    main()
