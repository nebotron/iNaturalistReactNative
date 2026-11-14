#!/usr/bin/env python3
"""
Backtest Explore filters for finding bird lifers with the Wildlife Hotspots finder.

For every lifer (a user's first observation of a bird species), rebuild the search the
user could have run the day before: birds they had not yet observed, inside an 80 km box
around where the lifer was found, counting only observations already uploaded by then.
Each time-window strategy (last N days, any time, the same month of any year, ...) is
then run through a port of the hotspot finder in
src/components/WildlifeHotspots/hooks/useRouteHotspots.ts: take the newest
`max observations`, split them with k-means into clusters of at most a 1.5 km radius,
count each species once per day per cluster, and rank the clusters by that count.

Success metric: the share of lifers whose species appears in one of the top-5 hotspots.

Only lifers whose first observation is research grade are scored; the "not yet seen"
filter still excludes every species the user had observed in any quality grade, as
Explore's unobserved_by_user_id filter does.

Requests are kept to a minimum: every API response is cached on disk, and the windows
"last N days" and "month +-1, last 3 years" are not queried at all; they are the newest
slice of the "any time" and "month +-1" result streams (ordered newest first).

Usage:
    python3 scripts/lifer_backtest.py --user ben142
    python3 scripts/lifer_backtest.py --user ben142 --caps 200,400,600,800,1000 --top 5
    python3 scripts/lifer_backtest.py --user ben142 --dry-run   # count uncached requests
    python3 scripts/lifer_backtest.py --user ben142 --offline   # cache only, no network
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import numpy as np

API_V1 = "https://api.inaturalist.org/v1"
API_V2_OBS = "https://api.inaturalist.org/v2/observations"
PAGE_SIZE = 200  # iNaturalist API cap, as in the app
EARTH_RADIUS_KM = 6371
BOX_PADDING_KM = 80  # hotspotBboxPaddingKm default
CLUSTER_RADIUS_KM = 1.5  # hotspotClusterRadiusKm default
REQUEST_DELAY_SEC = 1.0  # iNaturalist asks for at most ~1 request per second
DEFAULT_CACHE_DIR = Path.home( ) / ".cache" / "inat_lifer_backtest"

# Strategies that are queried; the rest are slices of these
STREAMS = ["any", "month", "month+-1"]
STRATEGIES = {
    # name: ( stream it is cut from, days back for d1 or None )
    "last7": ( "any", 7 ),
    "last14": ( "any", 14 ),
    "last30": ( "any", 30 ),
    "last60": ( "any", 60 ),
    "last90": ( "any", 90 ),
    "last180": ( "any", 180 ),
    "last365": ( "any", 365 ),
    "any": ( "any", None ),
    "month": ( "month", None ),
    "month+-1": ( "month+-1", None ),
    "month+-1_3y": ( "month+-1", 3 * 365 + 31 ),
}


# ---------------------------------------------------------------- HTTP with a disk cache

class Client:
    def __init__( self, cache_dir: Path, offline: bool, dry_run: bool ):
        self.cache_dir = cache_dir
        self.offline = offline
        self.dry_run = dry_run
        self.requests = 0
        self.missing = 0
        ( cache_dir / "queries" ).mkdir( parents=True, exist_ok=True )

    def _fetch( self, url: str ):
        for attempt in range( 6 ):
            try:
                with urllib.request.urlopen( url, timeout=60 ) as resp:
                    data = json.load( resp )
                self.requests += 1
                time.sleep( REQUEST_DELAY_SEC )
                return data
            except Exception as err:  # noqa: BLE001 - retry any network failure
                print( f"  retry {attempt + 1}: {err}", file=sys.stderr )
                time.sleep( 5 * ( attempt + 1 ) )
        raise SystemExit( f"Request failed repeatedly: {url[:200]}" )

    def observations( self, params: dict ):
        """v2 observation search, cached by its exact query string."""
        query = urllib.parse.urlencode( params )
        path = self.cache_dir / "queries" / f"{hashlib.md5( query.encode( ) ).hexdigest( )}.json"
        if path.exists( ):
            return json.loads( path.read_text( ) )
        if self.offline or self.dry_run:
            self.missing += 1
            return None
        data = self._fetch( f"{API_V2_OBS}?{query}" )
        path.write_text( json.dumps( data ) )
        return data


# ---------------------------------------------------------------- the user's birds

def resolve_user( client: Client, login: str ) -> int:
    path = client.cache_dir / f"user_{login}.json"
    if path.exists( ):
        return json.loads( path.read_text( ) )["id"]
    if client.offline:
        raise SystemExit( f"No cached user id for {login}" )
    data = client._fetch( f"{API_V1}/users/autocomplete?q={urllib.parse.quote( login )}" )
    match = next( ( u for u in data["results"] if u["login"] == login ), None )
    if not match:
        raise SystemExit( f"No iNaturalist user with login {login}" )
    path.write_text( json.dumps( { "id": match["id"], "login": login } ) )
    return match["id"]


def user_birds( client: Client, user_id: int, refresh: bool ) -> list[dict]:
    path = client.cache_dir / f"user_obs_{user_id}.json"
    if path.exists( ) and not refresh:
        return json.loads( path.read_text( ) )
    if client.offline:
        raise SystemExit( f"No cached observations for user {user_id}" )
    out, id_above = [], 0
    while True:
        data = client._fetch(
            f"{API_V1}/observations?user_id={user_id}&iconic_taxa=Aves&per_page=200"
            f"&order_by=id&order=asc&id_above={id_above}",
        )
        if not data["results"]:
            break
        for o in data["results"]:
            t = o.get( "taxon" ) or {}
            out.append( {
                "id": o["id"],
                "date": o.get( "observed_on" ),
                "time": o.get( "time_observed_at" ),
                "place": o.get( "place_guess" ),
                "loc": o.get( "location" ),
                "taxon_id": t.get( "id" ),
                "name": t.get( "name" ),
                "common": t.get( "preferred_common_name" ),
                "rank": t.get( "rank" ),
                "anc": t.get( "ancestor_ids" ),
                "quality": o.get( "quality_grade" ),
            } )
        id_above = data["results"][-1]["id"]
    path.write_text( json.dumps( out ) )
    return out


def species_of( o: dict ):
    if o["rank"] == "species":
        return o["taxon_id"]
    if o["rank"] in ( "subspecies", "variety", "form" ) and o["anc"]:
        return o["anc"][-2]
    return None


def find_lifers( birds: list[dict] ):
    """First observation of each species, and the first date each species was seen."""
    dated = [o for o in birds if species_of( o ) and o["date"]]
    first_seen = {}
    for o in sorted( dated, key=lambda o: o["date"] ):
        first_seen.setdefault( species_of( o ), o["date"] )
    lifers = {}
    for o in sorted( dated, key=lambda o: ( o["date"], o["time"] or "" ) ):
        lifers.setdefault( species_of( o ), o )
    out = []
    for sp, o in lifers.items( ):
        if not o["loc"]:
            continue
        lat, lng = map( float, o["loc"].split( "," ) )
        out.append( { **o, "sp": sp, "lat": lat, "lng": lng } )
    return out, first_seen


# ---------------------------------------------------------------- search parameters

def search_params( lat: float, lng: float, seen: list[int], day: str, stream: str ) -> dict:
    # Key order matters: it is the cache key
    dlat = BOX_PADDING_KM / 111
    dlng = BOX_PADDING_KM / ( 111 * max( 0.2, math.cos( math.radians( lat ) ) ) )
    p = {
        "iconic_taxa": "Aves",
        "verifiable": "true",
        "per_page": PAGE_SIZE,
        "order_by": "observed_on",
        "order": "desc",
        "swlat": round( lat - dlat, 3 ),
        "nelat": round( lat + dlat, 3 ),
        "swlng": round( lng - dlng, 3 ),
        "nelng": round( lng + dlng, 3 ),
        "fields": "(taxon:(id:!t,ancestor_ids:!t),location:!t,observed_on:!t)",
    }
    if seen:
        p["without_taxon_id"] = ",".join( map( str, seen ) )
    t = dt.date.fromisoformat( day )
    day_before = ( t - dt.timedelta( days=1 ) ).isoformat( )
    p["d2"] = day_before
    p["created_d2"] = day_before
    if stream == "month":
        p["month"] = str( t.month )
    elif stream == "month+-1":
        p["month"] = ",".join( str( ( t.month + i - 1 ) % 12 + 1 ) for i in ( -1, 0, 1 ) )
    return p


def fetch_stream( client: Client, params: dict, max_obs: int ):
    """Newest max_obs observations for a query, page by page; None if not cached offline."""
    results = []
    for page in range( 1, math.ceil( max_obs / PAGE_SIZE ) + 1 ):
        data = client.observations( params if page == 1 else { **params, "page": page } )
        if data is None:
            return None
        results += data["results"]
        if data["total_results"] <= PAGE_SIZE * page:
            break
    return results


# ---------------------------------------------------------------- hotspot finder port

def haversine_km( lat1, lng1, lat2, lng2 ):
    lat1, lng1, lat2, lng2 = map( np.radians, ( lat1, lng1, lat2, lng2 ) )
    a = ( np.sin( ( lat2 - lat1 ) / 2 ) ** 2
          + np.cos( lat1 ) * np.cos( lat2 ) * np.sin( ( lng2 - lng1 ) / 2 ) ** 2 )
    return EARTH_RADIUS_KM * 2 * np.arctan2( np.sqrt( a ), np.sqrt( 1 - a ) )


def run_kmeans( pts: np.ndarray, k: int, max_iter: int = 20 ):
    """runKMeans: farthest-first seeding from point 0, then Lloyd iterations."""
    n = len( pts )
    k = min( k, n )
    if k <= 0:
        return []
    seeds = [0]
    min_d = haversine_km( pts[:, 0], pts[:, 1], pts[0, 0], pts[0, 1] )
    while len( seeds ) < k:
        masked = min_d.copy( )
        masked[seeds] = -np.inf
        best = int( np.argmax( masked ) )
        seeds.append( best )
        min_d = np.minimum( min_d, haversine_km( pts[:, 0], pts[:, 1], pts[best, 0], pts[best, 1] ) )
    centroids = pts[seeds].copy( )
    assign = np.zeros( n, dtype=int )
    for it in range( max_iter ):
        dists = np.stack( [
            haversine_km( pts[:, 0], pts[:, 1], c[0], c[1] ) for c in centroids
        ], axis=1 )
        new_assign = np.argmin( dists, axis=1 )
        if it > 0 and np.array_equal( new_assign, assign ):
            break
        assign = new_assign
        for c in range( len( centroids ) ):
            members = pts[assign == c]
            if len( members ):
                centroids[c] = members.mean( axis=0 )
    return [
        ( centroids[c], np.flatnonzero( assign == c ) )
        for c in range( len( centroids ) ) if np.any( assign == c )
    ]


def split_to_radius( pts: np.ndarray, max_radius_km: float ):
    """splitToRadiusConstraint: bisect with k-means until each cluster fits the radius."""
    if len( pts ) == 0:
        return []
    clusters = run_kmeans( pts, 1 )
    centroid = clusters[0][0]
    exceeds = np.any( haversine_km( pts[:, 0], pts[:, 1], centroid[0], centroid[1] ) > max_radius_km )
    if not exceeds or len( pts ) <= 1:
        return [clusters[0]]
    out = []
    for _, half in run_kmeans( pts, 2 ):
        for sub_centroid, sub in split_to_radius( pts[half], max_radius_km ):
            out.append( ( sub_centroid, half[sub] ) )
    return out


def top_hotspot_taxa( observations: list[dict], top: int ) -> set[int]:
    """Taxa (with ancestors) seen in the top hotspots, ranked by de-duplicated count.

    The app ranks by ( detour + parking minutes ) / count; with the route centred on the
    search area every candidate's detour is treated as equal, so this is count order.
    """
    pts, obs = [], []
    for o in observations:
        if o.get( "location" ) and o.get( "taxon" ):
            lat, lng = map( float, o["location"].split( "," ) )
            pts.append( ( lat, lng ) )
            obs.append( o )
    if not pts:
        return set( )
    cells = []
    for _, members in split_to_radius( np.array( pts ), CLUSTER_RADIUS_KM ):
        species_days = set( )
        taxa = set( )
        for i in members:
            o = obs[i]
            species_days.add( ( o["taxon"]["id"], o.get( "observed_on" ) ) )
            taxa.update( o["taxon"].get( "ancestor_ids" ) or [o["taxon"]["id"]] )
        cells.append( ( len( species_days ), taxa ) )
    cells.sort( key=lambda c: -c[0] )  # stable, like the app's sort
    found = set( )
    for _, taxa in cells[:top]:
        found |= taxa
    return found


# ---------------------------------------------------------------- the backtest

def build_groups( lifers: list[dict] ):
    """Lifers found on one day within about half a degree share one search area."""
    groups = {}
    for o in lifers:
        key = ( o["date"], round( o["lat"] * 2 ) / 2, round( o["lng"] * 2 ) / 2 )
        groups.setdefault( key, [] ).append( o )
    return groups


def strategy_slice( stream_obs: list[dict], day: str, days_back, cap: int ):
    if days_back is None:
        return stream_obs[:cap]
    d1 = ( dt.date.fromisoformat( day ) - dt.timedelta( days=days_back ) ).isoformat( )
    return [o for o in stream_obs if ( o.get( "observed_on" ) or "" ) >= d1][:cap]


def score_group( job ):
    day, targets, streams, caps, top = job
    memo, out = {}, []
    for name, ( stream, days_back ) in STRATEGIES.items( ):
        for cap in caps:
            sliced = strategy_slice( streams[stream], day, days_back, cap )
            key = tuple( o.get( "uuid" ) for o in sliced )
            if key not in memo:
                memo[key] = top_hotspot_taxa( sliced, top )
            found = memo[key]
            for t in targets:
                out.append( ( t["id"], name, cap, t["sp"] in found ) )
    return out


def main( ):
    parser = argparse.ArgumentParser( description=__doc__.split( "\n\n" )[0] )
    parser.add_argument( "--user", required=True, help="iNaturalist login" )
    parser.add_argument( "--caps", default="200,400,600,800,1000",
                         help="max observations settings to test (multiples of 200)" )
    parser.add_argument( "--top", type=int, default=5, help="count a hit in the top N hotspots" )
    parser.add_argument( "--cache-dir", type=Path, default=DEFAULT_CACHE_DIR )
    parser.add_argument( "--offline", action="store_true", help="use only cached responses" )
    parser.add_argument( "--dry-run", action="store_true",
                         help="report how many uncached requests a run needs, then stop" )
    parser.add_argument( "--refresh-user", action="store_true",
                         help="re-download the user's observations (quality grades change)" )
    parser.add_argument( "--workers", type=int, default=os.cpu_count( ) or 1 )
    args = parser.parse_args( )
    caps = sorted( int( c ) for c in args.caps.split( "," ) )
    if any( c % PAGE_SIZE for c in caps ):
        raise SystemExit( "--caps must be multiples of 200" )

    client = Client( args.cache_dir, args.offline, args.dry_run )
    user_id = resolve_user( client, args.user )
    lifers, first_seen = find_lifers( user_birds( client, user_id, args.refresh_user ) )
    scored = [o for o in lifers if o["quality"] == "research"]
    scored_ids = { o["id"] for o in scored }
    print( f"{len( lifers )} lifers, {len( scored )} research grade", flush=True )

    # Search areas are centred on every lifer of the day, research grade or not, so the
    # queries (and the cache) stay the same when quality grades change
    groups = build_groups( lifers )
    jobs, skipped = [], 0
    for n, ( ( day, _, _ ), members ) in enumerate( sorted( groups.items( ) ), 1 ):
        targets = [o for o in members if o["id"] in scored_ids]
        if not targets:
            continue
        seen = [sp for sp, first in first_seen.items( ) if first < day]
        lat = sum( o["lat"] for o in members ) / len( members )
        lng = sum( o["lng"] for o in members ) / len( members )
        streams = {
            s: fetch_stream( client, search_params( lat, lng, seen, day, s ), caps[-1] )
            for s in STREAMS
        }
        if any( v is None for v in streams.values( ) ):
            skipped += 1
            continue
        jobs.append( ( day, targets, streams, caps, args.top ) )
        if client.requests:
            print( f"  area {n}/{len( groups )} {day}: {client.requests} requests so far",
                   flush=True )

    if args.dry_run:
        print( f"At least {client.missing} uncached requests needed "
               "(later pages are only requested when earlier ones are full)" )
        return
    print( f"{client.requests} new API requests; scoring {len( jobs )} search areas"
           + ( f" ({skipped} skipped: not cached)" if skipped else "" ), flush=True )

    with Pool( args.workers ) as pool:
        rows = [r for part in pool.map( score_group, jobs ) for r in part]

    hits = Counter( ( name, cap ) for _, name, cap, hit in rows if hit )
    n_lifers = len( { r[0] for r in rows } )
    print( f"\nResearch-grade lifers whose species was in a top-{args.top} hotspot "
           f"(n = {n_lifers})\n" )
    print( f"{'strategy':<14}" + "".join( f"{c:>8}" for c in caps ) )
    for name in STRATEGIES:
        print( f"{name:<14}" + "".join(
            f"{100 * hits[( name, c )] / n_lifers:>7.1f}%" for c in caps
        ) )

    results_path = args.cache_dir / f"results_{args.user}_top{args.top}.json"
    results_path.write_text( json.dumps( {
        "user": args.user,
        "top": args.top,
        "caps": caps,
        "lifers_scored": n_lifers,
        "percent": {
            name: { c: round( 100 * hits[( name, c )] / n_lifers, 1 ) for c in caps }
            for name in STRATEGIES
        },
        "per_lifer": [
            { "observation_id": oid, "strategy": name, "cap": cap, "hit": hit }
            for oid, name, cap, hit in rows
        ],
    }, indent=1 ) )
    print( f"\nSaved {results_path}" )


if __name__ == "__main__":
    sys.setrecursionlimit( 10000 )
    main( )
