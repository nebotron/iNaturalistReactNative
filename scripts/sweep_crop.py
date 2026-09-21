#!/usr/bin/env python3
"""
Sweep crop post-processing variants over a cached detection set.

Reads the .npz written by cache_detections.py (raw post-NMS, pre-gate boxes)
and scores gate / algorithm / padding combinations without re-running the
model, so a full sweep takes seconds instead of the better part of an hour.

Usage:
    python3 scripts/sweep_crop.py DETS.npz [--slice first:last] [--baseline-only]
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )
from evaluate_subject_detector import _spectral_saliency_bounds

SAL_CACHE = Path( "/tmp/inat_saliency_cache.npz" )

DEFAULT_GATE = 0.50
DEFAULT_UNION_THRESH = 0.60
DEFAULT_UNION_K = 3


def _sal( path ):
    b = _spectral_saliency_bounds( path )
    return ( -1, -1, -1, -1 ) if b is None else b


def load( npz_path: Path ):
    z = np.load( npz_path, allow_pickle=True )
    counts = z["counts"]
    flat = z["dets"]
    offs = np.concatenate( [[0], np.cumsum( counts )] )
    dets = [flat[offs[i]:offs[i + 1]] for i in range( len( counts ) )]
    return dets, z["truths"], z["sizes"], z["urls"], z["paths"]


def saliency_for( paths ):
    """Model-independent, so it is cached once and reused across every run."""
    if SAL_CACHE.exists():
        z = np.load( SAL_CACHE, allow_pickle=True )
        if len( z["paths"] ) == len( paths ) and ( z["paths"] == paths ).all():
            return z["sal"]
    print( "Computing saliency fallback …", flush=True )
    with ProcessPoolExecutor( max_workers=4 ) as ex:
        sal = np.array( list( ex.map( _sal, list( paths ), chunksize=32 ) ), dtype=np.float32 )
    np.savez_compressed( SAL_CACHE, paths=paths, sal=sal )
    return sal


def union_bounds( d, thresh, k ):
    best = d[0, 4]
    valid = d[d[:, 4] >= thresh * best][:k]
    if len( valid ) == 0:
        valid = d[:1]
    x1 = valid[:, 0].min()
    y1 = valid[:, 1].min()
    x2 = ( valid[:, 0] + valid[:, 2] ).max()
    y2 = ( valid[:, 1] + valid[:, 3] ).max()
    return x1, y1, x2 - x1, y2 - y1


def bounds_array( dets, sal, gate, thresh=DEFAULT_UNION_THRESH, k=DEFAULT_UNION_K, algo="union" ):
    """Vectorless but cheap: one pass producing an (N,4) bounds array; rows that
    neither the model nor saliency could fill are marked with NaN and dropped,
    exactly as the eval script drops them."""
    out = np.full( ( len( dets ), 4 ), np.nan, dtype=np.float64 )
    for i, d in enumerate( dets ):
        if len( d ) and d[0, 4] >= gate:
            out[i] = ( d[0, :4] if algo == "top1" else union_bounds( d, thresh, k ) )
        elif sal[i][0] >= 0:
            out[i] = sal[i]
    return out


def score( bounds, truths, sizes, padding=0.0 ):
    """Vectorized replica of bounds_to_crop + recall/precision/weighted_score."""
    ok = ~np.isnan( bounds[:, 0] )
    b = bounds[ok]
    t = truths[ok].astype( np.float64 )
    W = sizes[ok, 0].astype( np.float64 )
    H = sizes[ok, 1].astype( np.float64 )

    bw = np.maximum( b[:, 2], 1e-9 )
    bh = np.maximum( b[:, 3], 1e-9 )
    side_px = np.maximum( bw * ( 1 + padding ) * W, bh * ( 1 + padding ) * H )
    w = side_px / W
    h = side_px / H
    cx = b[:, 0] + bw / 2
    cy = b[:, 1] + bh / 2
    x = np.where( w <= 1.0, np.clip( cx - w / 2, 0.0, np.maximum( 1.0 - w, 0.0 ) ), cx - w / 2 )
    y = np.where( h <= 1.0, np.clip( cy - h / 2, 0.0, np.maximum( 1.0 - h, 0.0 ) ), cy - h / 2 )

    # recall — against the truth shrunk 8% per side
    sx = t[:, 0] + t[:, 2] * 0.08
    sy = t[:, 1] + t[:, 3] * 0.08
    sw = np.maximum( t[:, 2] * 0.84, 0.0 )
    sh = np.maximum( t[:, 3] * 0.84, 0.0 )
    inter_s = ( np.maximum( 0, np.minimum( x + w, sx + sw ) - np.maximum( x, sx ) ) *
                np.maximum( 0, np.minimum( y + h, sy + sh ) - np.maximum( y, sy ) ) )
    area_s = sw * sh
    r = np.where( area_s > 0, inter_s / np.maximum( area_s, 1e-12 ), 0.0 )

    # precision — intersection with the full truth over the square viewport
    inter_t = ( np.maximum( 0, np.minimum( x + w, t[:, 0] + t[:, 2] ) - np.maximum( x, t[:, 0] ) ) *
                np.maximum( 0, np.minimum( y + h, t[:, 1] + t[:, 3] ) - np.maximum( y, t[:, 1] ) ) )
    side = np.maximum( w, h )
    p = inter_t / np.maximum( side * side, 1e-12 )

    s = ( 4 * r + p ) / 5
    return s, r, p, ok


def summarize( name, dets, sal, truths, sizes, gate, pad=0.0, **kw ):
    b = bounds_array( dets, sal, gate, **kw )
    s, r, p, ok = score( b, truths, sizes, pad )
    print( f"  {name:<34} n={ok.sum():<5} gate={gate:.2f} pad={pad:.2f}  "
           f"recall={r.mean():.4f}  prec={p.mean():.4f}  score={s.mean():.4f}" )
    return s.mean()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "npz" )
    ap.add_argument( "--slice", default=None, help="index range into the log, e.g. 6143:7143" )
    ap.add_argument( "--full", action="store_true", help="sweep every knob, not just the gate" )
    args = ap.parse_args()

    dets, truths, sizes, urls, paths = load( Path( args.npz ) )
    sal = saliency_for( paths )

    if args.slice:
        a, b = args.slice.split( ":" )
        lo = int( a ) if a else 0
        hi = int( b ) if b else len( dets )
        dets, truths, sizes, sal, paths = dets[lo:hi], truths[lo:hi], sizes[lo:hi], sal[lo:hi], paths[lo:hi]
        print( f"slice {lo}:{hi} → {len(dets)} images" )

    print( f"\n{len(dets)} images\n" )

    print( "Gate sweep (union, pad=0):" )
    best = ( -1, None )
    for g in [0.0, 0.10, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]:
        v = summarize( f"gate={g:.2f}", dets, sal, truths, sizes, g )
        if v > best[0]:
            best = ( v, g )
    print( f"\n  best gate = {best[1]:.2f}  score = {best[0]:.4f}\n" )

    if args.full:
        g = best[1]
        print( "Padding sweep:" )
        for pad in [-0.10, -0.05, -0.02, 0.0, 0.03, 0.05, 0.10, 0.15, 0.20]:
            summarize( f"pad={pad:+.2f}", dets, sal, truths, sizes, g, pad=pad )
        print( "\nUnion threshold / K:" )
        for th in [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]:
            for k in [1, 2, 3, 5]:
                summarize( f"thresh={th} k={k}", dets, sal, truths, sizes, g, thresh=th, k=k )
        print( "\ntop1:" )
        summarize( "top1", dets, sal, truths, sizes, g, algo="top1" )


if __name__ == "__main__":
    main()
