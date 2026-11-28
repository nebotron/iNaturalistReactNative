#!/usr/bin/env python3
"""
Score subsets of test-time-augmentation views from the per-view cache written by scripts/cache_views.py.

Each subset is fused exactly as ImageCropper.m does it (weighted box fusion,
conf = sum / number of views run, top fused box, saliency fallback when no
view finds anything), squared by bounds_to_crop and scored by IoU inside the
image (sweep_crop.score). Cost is counted per photo as canvas pixels relative
to one 640×640 inference, so tight canvases are charged what they would cost on the phone.

Usage:
    python3 scripts/sweep_views.py VIEWS.npz[,MORE.npz] [--slice 9187:] [--subsets [--max-views 3] [--views a,b,...]]
"""

from __future__ import annotations

import argparse
import itertools
import sys
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )
import cache_detections as cd
from cache_detections import view_cost
from sweep_crop import saliency_for, score

# The four 640×640 views shipped before the tight-canvas change; the baseline
# every subset is compared against.
PREVIOUS = ( "o640sq640", "h640sq640", "o320sq640", "o914sq640" )
SHIPPED = tuple( cd.VIEWS )


class Views:
    def __init__( self, npz, slice_: str | None = None ):
        # Several caches of the same images (one per batch of views) are merged.
        zs = [np.load( p, allow_pickle=True ) for p in str( npz ).split( "," )]
        z = zs[0]
        for other in zs[1:]:
            assert ( other["urls"] == z["urls"] ).all(), "caches cover different images"
        self.names = [v for zz in zs for v in zz["views"]]
        arrays = { k: zz[k] for zz in zs for k in zz.files }
        n = len( z["truths"] )
        lo, hi = 0, n
        if slice_:
            a, _, b = slice_.partition( ":" )
            lo = int( a ) if a else 0
            hi = int( b ) if b else n
            lo, hi = ( lo + n if lo < 0 else lo ), ( hi + n if hi < 0 else hi )
        self.truths = z["truths"][lo:hi]
        self.sizes = z["sizes"][lo:hi]
        self.paths = z["paths"][lo:hi]
        self.dets = {}
        for v in self.names:
            counts = arrays[f"counts_{v}"]
            offs = np.concatenate( [[0], np.cumsum( counts )] )
            flat = arrays[f"dets_{v}"]
            self.dets[v] = [flat[offs[i]:offs[i + 1]] for i in range( lo, hi )]
        self.costs = { v: np.array( [view_cost( v, int( w ), int( h ) ) for w, h in self.sizes] )
                       for v in self.names }
        self._sal = None

    def __len__( self ):
        return len( self.truths )

    def sal( self, i ):
        if self._sal is None:  # one batched lookup; saliency_for caches per path
            self._sal = saliency_for( self.paths )
        return self._sal[i]

    def fused( self, i, views ):
        return cd.fuse_views( [self.dets[v][i] for v in views] )

    def bounds_for( self, i, fused ):
        if len( fused ):
            return fused[0, :4]
        s = self.sal( i )
        return s if s[0] >= 0 else np.full( 4, np.nan )

    def evaluate( self, views ):
        b = np.array( [self.bounds_for( i, self.fused( i, views ) ) for i in range( len( self ) )] )
        s, _, _, ok = score( b, self.truths, self.sizes )
        full = np.zeros( len( self ) )
        full[ok] = s
        cost = sum( self.costs[v] for v in views )
        return full, cost


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "npz", help="cache_views.py output; several comma-separated are merged" )
    ap.add_argument( "--slice", default=None )
    ap.add_argument( "--subsets", action="store_true", help="score every subset of up to --max-views views" )
    ap.add_argument( "--max-views", type=int, default=3 )
    ap.add_argument( "--views", default=None, help="comma-separated pool for --subsets" )
    args = ap.parse_args()

    V = Views( args.npz, args.slice )
    print( f"{len(V)} images, views: {', '.join( V.names )}\n" )
    for label, views in ( ( "previous", PREVIOUS ), ( "shipped", SHIPPED ) ):
        if all( v in V.names for v in views ):
            s, c = V.evaluate( views )
            print( f"{label} {'+'.join( views )}: score {s.mean():.4f}  cost {c.mean():.2f}" )
    print()
    for v in V.names:
        s, c = V.evaluate( ( v, ) )
        print( f"  {v:<12} score {s.mean():.4f}  cost {c.mean():.2f}" )

    if args.subsets:
        pool = args.views.split( "," ) if args.views else V.names
        rows = []
        for k in range( 1, args.max_views + 1 ):
            for combo in itertools.combinations( pool, k ):
                s, c = V.evaluate( combo )
                rows.append( ( s.mean(), c.mean(), combo ) )
        rows.sort( key=lambda r: r[1] )
        print( "\nPareto front (cost ascending, each better than every cheaper one):" )
        best = -1
        for s, c, combo in rows:
            if s > best:
                best = s
                print( f"  cost {c:.2f}  score {s:.4f}  {'+'.join( combo )}" )


if __name__ == "__main__":
    main()
