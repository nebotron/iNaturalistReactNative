#!/usr/bin/env python3
"""
Second-pass detections for small subjects, cached like cache_detections.py.

At 640px a subject a tenth of the frame wide is ~64px and one a twentieth is
~32px — near the bottom of what yolov8n resolves. This re-runs the detector on
sub-regions of the 1024px image so a small subject is seen at higher resolution:

  zoom  — a square around the first pass's top box, ZOOM × its side
  tiles — a 2×2 grid of overlapping tiles (each TILE_FRAC of the image)

All boxes are written back in whole-image normalised coordinates, so
sweep_crop-style arithmetic can combine them with the first pass.

Usage:
    python3 scripts/cache_zoom.py MODEL.onnx BASE.npz OUT.npz [--zoom 3]
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
from sweep_crop import load

TILE_FRAC = 0.6


def _run_region( img: PILImage.Image, rx, ry, rw, rh ):
    """Detect inside the pixel region (rx, ry, rw, rh) of img; boxes come back
    normalised to the whole image. Parts of the region outside the image are
    letterbox grey, as on device."""
    W, H = img.size
    canvas = PILImage.new( "RGB", ( int( round( rw ) ), int( round( rh ) ) ), ( 114, 114, 114 ) )
    canvas.paste( img.crop( ( int( round( rx ) ), int( round( ry ) ),
                              int( round( rx + rw ) ), int( round( ry + rh ) ) ) ), ( 0, 0 ) )
    d = cd._detect_array( np.array( canvas ), canvas.size[0], canvas.size[1] )
    if len( d ) == 0:
        return d
    d = d.copy()
    d[:, 0] = ( rx + d[:, 0] * rw ) / W
    d[:, 1] = ( ry + d[:, 1] * rh ) / H
    d[:, 2] = d[:, 2] * rw / W
    d[:, 3] = d[:, 3] * rh / H
    return d


def _work( args ):
    idx, path, top, zoom = args
    try:
        img = PILImage.open( path ).convert( "RGB" )
    except Exception:
        return idx, np.zeros( ( 0, 5 ), np.float32 ), np.zeros( ( 0, 6 ), np.float32 )
    W, H = img.size
    zd = np.zeros( ( 0, 5 ), np.float32 )
    if top is not None:
        bx, by, bw, bh = top
        side = min( max( bw * W, bh * H ) * zoom, max( W, H ) )
        cx, cy = ( bx + bw / 2 ) * W, ( by + bh / 2 ) * H
        rx = min( max( cx - side / 2, 0 ), max( W - side, 0 ) ) if side <= W else ( W - side ) / 2
        ry = min( max( cy - side / 2, 0 ), max( H - side, 0 ) ) if side <= H else ( H - side ) / 2
        zd = _run_region( img, rx, ry, side, side )
    tiles = []
    tw, th = W * TILE_FRAC, H * TILE_FRAC
    for t, ( rx, ry ) in enumerate( [( 0, 0 ), ( W - tw, 0 ), ( 0, H - th ), ( W - tw, H - th )] ):
        d = _run_region( img, rx, ry, tw, th )
        if len( d ):
            tiles.append( np.hstack( [d, np.full( ( len( d ), 1 ), t, np.float32 )] ) )
    td = np.concatenate( tiles ) if tiles else np.zeros( ( 0, 6 ), np.float32 )
    return idx, zd.astype( np.float32 ), td.astype( np.float32 )


def _flat( rs, ncol ):
    counts = np.array( [len( r ) for r in rs], np.int32 )
    flat = np.concatenate( [r for r in rs if len( r )] ) if counts.sum() else np.zeros( ( 0, ncol ), np.float32 )
    return counts, flat


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "model" )
    ap.add_argument( "base" )
    ap.add_argument( "out" )
    ap.add_argument( "--zoom", type=float, default=3.0 )
    args = ap.parse_args()

    dets, truths, sizes, urls, paths = load( Path( args.base ) )
    tasks = [( i, str( p ), ( tuple( d[0, :4] ) if len( d ) else None ), args.zoom )
             for i, ( d, p ) in enumerate( zip( dets, paths ) )]
    Z = [None] * len( tasks )
    T = [None] * len( tasks )
    with ProcessPoolExecutor( max_workers=4, initializer=cd._init,
                              initargs=( str( Path( args.model ).resolve() ), ) ) as ex:
        for n, ( i, z, t ) in enumerate( ex.map( _work, tasks, chunksize=16 ) ):
            Z[i], T[i] = z, t
            if ( n + 1 ) % 500 == 0:
                print( f"  {n+1}/{len(tasks)}", flush=True )
    zc, zf = _flat( Z, 5 )
    tc, tf = _flat( T, 6 )
    np.savez_compressed( args.out, zcounts=zc, zdets=zf, tcounts=tc, tdets=tf, zoom=args.zoom )
    print( f"Wrote {args.out}" )


if __name__ == "__main__":
    main()
