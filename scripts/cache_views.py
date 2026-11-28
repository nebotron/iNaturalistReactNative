#!/usr/bin/env python3
"""
Run the detector over the crop log once per candidate *view* and store every
view's post-NMS boxes separately, so any subset of views and any fusion rule
can be scored afterwards in seconds (see
scripts/sweep_views.py) instead of re-running inference per combination.

View names are those of cache_detections.VIEWS ([o|h]<L><sq|t><S>; see the
comment there). The shipped model takes any H×W; a model exported with
dynamic=False only runs the *sq640 views.

Usage:
    python3 scripts/cache_views.py MODEL.onnx OUT.npz [--views o640sq640,...]
                                   [--slice first:last] [--json crop_training.json]
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image as PILImage

sys.path.insert( 0, str( Path( __file__ ).parent ) )
import cache_detections as cd

REPO_ROOT = Path( __file__ ).parent.parent

# The four views shipped before this script existed, then cheaper candidates.
DEFAULT_VIEWS = [
    "o640sq640", "h640sq640", "o320sq640", "o914sq640",
    "o640t640", "h640t640", "o320t640", "o914t640",
    "o480t640", "h480t640", "o416t640", "o512t640",
    "o640t480", "o800t640", "h320t640", "o384t640",
]

def _task( args ):
    idx, path, views = args
    try:
        img = PILImage.open( path ).convert( "RGB" )
    except Exception:
        return idx, [np.zeros( ( 0, 5 ), np.float32 ) for _ in views]
    return idx, [cd.detect_view( img, v ) for v in views]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "model" )
    ap.add_argument( "out" )
    ap.add_argument( "--json", default=str( REPO_ROOT / "crop_training.json" ) )
    ap.add_argument( "--views", default=",".join( DEFAULT_VIEWS ) )
    ap.add_argument( "--slice", default=None )
    ap.add_argument( "--workers", type=int, default=4 )
    args = ap.parse_args()
    views = args.views.split( "," )
    for v in views:
        cd.parse_view( v )

    entries = cd.load_entries( Path( args.json ) )
    if args.slice:
        lo, _, hi = args.slice.partition( ":" )
        entries = entries[int( lo ) if lo else None:int( hi ) if hi else None]
    print( f"{len(entries)} images × {len(views)} views", flush=True )

    tasks = [( i, str( p ), views ) for i, ( _, p, _, _ ) in enumerate( entries )]
    results = [None] * len( tasks )
    with ProcessPoolExecutor( max_workers=args.workers, initializer=cd._init,
                              initargs=( str( Path( args.model ).resolve() ), ) ) as ex:
        for n, ( idx, dets ) in enumerate( ex.map( _task, tasks, chunksize=8 ) ):
            results[idx] = dets
            if ( n + 1 ) % 250 == 0:
                print( f"  {n+1}/{len(tasks)}", flush=True )

    out = dict(
        views=np.array( views ),
        truths=np.array( [e[0] for e in entries], np.float32 ),
        sizes=np.array( [e[2] for e in entries], np.int32 ),
        urls=np.array( [e[3] for e in entries] ),
        paths=np.array( [str( e[1] ) for e in entries] ),
    )
    for vi, v in enumerate( views ):
        per = [r[vi] for r in results]
        out[f"counts_{v}"] = np.array( [len( d ) for d in per], np.int32 )
        out[f"dets_{v}"] = np.concatenate( per ) if sum( map( len, per ) ) else np.zeros( ( 0, 5 ), np.float32 )
    np.savez_compressed( args.out, **out )
    print( f"Wrote {args.out}" )


if __name__ == "__main__":
    main()
