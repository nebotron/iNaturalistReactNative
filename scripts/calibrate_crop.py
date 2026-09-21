#!/usr/bin/env python3
"""
Fit the crop geometry the detector's boxes should actually produce.

The app crops the square that circumscribes the detected box. That treats the
box as if it were the answer, but it is a noisy estimate of where a human chose
to crop, and the score weights recall four times precision — so the crop that
maximizes the score is not the box. This fits a small geometry correction:

    side'   = (k0 + k1·(1 - conf)) · side^beta
    centre' = centre pulled (g0 + g1·(1 - conf)) of the way to the image centre

With k0=1, k1=0, beta=1, g0=g1=0 this reproduces the shipped behaviour. Letting
beta fall below 1 expands small boxes and leaves large ones alone; letting k1
and g1 rise makes a low-confidence detection crop bigger and closer to centre,
which is what the hard confidence gate approximates in one step.

The fit has to happen on images the detector did not train on, or it calibrates
against memorized detections and reports a gain that will not survive. Hence
k-fold cross-validation strictly inside the held-out tail.

Usage:
    python3 scripts/calibrate_crop.py DETS.npz [--tail 1000] [--folds 5]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )
from sweep_crop import load, saliency_for, bounds_array, score

# (k0, k1, beta, g0, g1) — the shipped behaviour, and the search bounds.
SHIPPED = ( 1.0, 0.0, 1.0, 0.0, 0.0 )
BOUNDS = ( ( 0.70, 1.40 ), ( -0.40, 0.80 ), ( 0.60, 1.20 ), ( -0.10, 0.40 ), ( -0.20, 0.60 ) )


def geometry( bounds, conf, sizes, params, apply_to ):
    k0, k1, beta, g0, g1 = params
    W = sizes[:, 0].astype( float )
    H = sizes[:, 1].astype( float )
    M = np.maximum( W, H )
    out = bounds.copy()
    s = np.maximum( np.maximum( bounds[:, 2] * W, bounds[:, 3] * H ) / M, 1e-6 )
    lack = 1.0 - conf
    s2 = np.clip( ( k0 + k1 * lack ) * s ** beta, 0.02, 3.0 )
    gam = np.clip( g0 + g1 * lack, -0.5, 0.95 )
    cx = bounds[:, 0] + bounds[:, 2] / 2
    cy = bounds[:, 1] + bounds[:, 3] / 2
    nw = s2 * M / W
    nh = s2 * M / H
    sel = apply_to & np.isfinite( bounds[:, 0] )
    out[sel, 2] = nw[sel]
    out[sel, 3] = nh[sel]
    out[sel, 0] = ( cx + gam * ( 0.5 - cx ) )[sel] - nw[sel] / 2
    out[sel, 1] = ( cy + gam * ( 0.5 - cy ) )[sel] - nh[sel] / 2
    return out


def coordinate_search( objective, start, bounds, rounds=4 ):
    """Grid search one parameter at a time, narrowing each round.

    Five parameters make a full grid wasteful and Nelder-Mead needs scipy, which
    this environment does not carry; coordinate descent from the shipped values
    is enough for a surface this smooth and never lands worse than its start.
    """
    best = list( start )
    best_val = objective( best )
    for r in range( rounds ):
        span = 0.5 ** r
        for i, ( lo, hi ) in enumerate( bounds ):
            width = ( hi - lo ) * span / 2
            lo_i = max( lo, best[i] - width )
            hi_i = min( hi, best[i] + width )
            for v in np.linspace( lo_i, hi_i, 9 ):
                trial = list( best )
                trial[i] = float( v )
                val = objective( trial )
                if val > best_val:
                    best_val, best = val, trial
    return tuple( best ), best_val


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "npz" )
    ap.add_argument( "--tail", type=int, default=1000 )
    ap.add_argument( "--folds", type=int, default=5 )
    ap.add_argument( "--gate", type=float, default=0.0,
                     help="confidence gate kept in front of the calibration "
                          "(0 lets the calibration replace it entirely)" )
    args = ap.parse_args()

    dets, truths, sizes, urls, paths = load( Path( args.npz ) )
    sal = saliency_for( paths )
    n = len( truths )
    tail = np.arange( n - args.tail, n )

    conf = np.array( [d[0, 4] if len( d ) else 0.0 for d in dets], dtype=float )
    have_det = np.array( [len( d ) > 0 for d in dets] )

    shipped = bounds_array( dets, sal, 0.50 )
    base = float( score( shipped[tail], truths[tail], sizes[tail], 0.0 )[0].mean() )
    print( f"shipped (gate 0.50) on the held-out tail: {base:.4f}\n" )

    bounds = bounds_array( dets, sal, args.gate )
    apply_to = have_det if args.gate <= 0 else ( conf >= args.gate )

    def obj_on( idx ):
        def f( p ):
            b = geometry( bounds, conf, sizes, p, apply_to )
            return float( score( b[idx], truths[idx], sizes[idx], 0.0 )[0].mean() )
        return f

    rng = np.random.default_rng( 0 )
    folds = rng.permutation( tail ).reshape( args.folds, -1 )
    cv, picks = [], []
    for f in range( args.folds ):
        test = folds[f]
        fit = np.concatenate( [folds[j] for j in range( args.folds ) if j != f] )
        p, _ = coordinate_search( obj_on( fit ), SHIPPED, BOUNDS )
        cv.append( obj_on( test )( p ) )
        picks.append( p )
        print( f"  fold {f}: k0={p[0]:.2f} k1={p[1]:+.2f} beta={p[2]:.2f} "
               f"g0={p[3]:+.2f} g1={p[4]:+.2f}  -> test {cv[-1]:.4f}" )

    med = tuple( float( np.median( [p[i] for p in picks] ) ) for i in range( 5 ) )
    print( f"\n{args.folds}-fold CV (honest): {np.mean(cv):.4f}   "
           f"shipped {base:.4f}   delta {np.mean(cv) - base:+.4f}" )
    print( f"median parameters: k0={med[0]:.3f} k1={med[1]:+.3f} beta={med[2]:.3f} "
           f"g0={med[3]:+.3f} g1={med[4]:+.3f}" )
    b = geometry( bounds, conf, sizes, med, apply_to )
    for name, idx in ( ( "held-out tail", tail ), ( "whole log", np.arange( n ) ) ):
        s, r, p_, ok = score( b[idx], truths[idx], sizes[idx], 0.0 )
        print( f"  those parameters on the {name:<14}: score={s.mean():.4f} "
               f"recall={r.mean():.4f} prec={p_.mean():.4f}" )


if __name__ == "__main__":
    main()
