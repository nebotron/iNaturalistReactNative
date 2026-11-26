#!/usr/bin/env python3
"""
Compare two crop models honestly.

The crop log is chronological, so its tail is the only slice a previously
shipped model cannot have trained on. A straight whole-log comparison flatters
whichever model saw more of the log, which is always the newer one — so this
reports the tail separately and bootstraps a confidence interval on the
difference there.

Usage:
    python3 scripts/compare_models.py OLD.npz NEW.npz [--tail 1000]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )
from sweep_crop import load, saliency_for, bounds_array, score

GATES = [0.0, 0.10, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45,
         0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]


def per_image( dets, sal, truths, sizes, gate ):
    b = bounds_array( dets, sal, gate )
    s, r, p, ok = score( b, truths, sizes, 0.0 )
    out = np.full( len( dets ), np.nan )
    out[ok] = s
    rr = np.full( len( dets ), np.nan )
    rr[ok] = r
    pp = np.full( len( dets ), np.nan )
    pp[ok] = p
    return out, rr, pp


def best_gate( dets, sal, truths, sizes, idx ):
    best = ( -1.0, None )
    for g in GATES:
        s, _, _ = per_image( dets, sal, truths, sizes, g )
        v = float( np.nanmean( s[idx] ) )
        if v > best[0]:
            best = ( v, g )
    return best[1], best[0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "old_npz" )
    ap.add_argument( "new_npz" )
    ap.add_argument( "--tail", type=int, default=1000 )
    args = ap.parse_args()

    old = load( Path( args.old_npz ) )
    new = load( Path( args.new_npz ) )
    if not ( old[3] == new[3] ).all():
        sys.exit( "The two caches cover different images — regenerate both." )
    truths, sizes, paths = old[1], old[2], old[4]
    sal = saliency_for( paths )
    n = len( truths )

    whole = np.arange( n )
    tail = np.arange( n - args.tail, n )

    print( f"{n} images; honest held-out tail = last {args.tail}\n" )

    rows = []
    for name, dets in ( ( "old", old[0] ), ( "new", new[0] ) ):
        g_all, s_all = best_gate( dets, sal, truths, sizes, whole )
        g_tail, s_tail = best_gate( dets, sal, truths, sizes, tail )
        rows.append( ( name, dets, g_all, s_all, g_tail, s_tail ) )
        print( f"  {name}: whole log  best gate {g_all:.2f} → {s_all:.4f}" )
        print( f"  {name}: held-out   best gate {g_tail:.2f} → {s_tail:.4f}" )

    # Compare on the tail at each model's own best whole-log gate, which is what
    # would actually ship.
    print( "\nHeld-out tail, each model at its shipping gate:" )
    per = {}
    for name, dets, g_all, _, _, _ in rows:
        s, r, p = per_image( dets, sal, truths, sizes, g_all )
        per[name] = s[tail]
        print( f"  {name:<4} gate={g_all:.2f}  score={np.nanmean(s[tail]):.4f}  "
               f"recall={np.nanmean(r[tail]):.4f}  prec={np.nanmean(p[tail]):.4f}" )

    d = per["new"] - per["old"]
    d = d[np.isfinite( d )]
    rng = np.random.default_rng( 0 )
    boot = np.array( [rng.choice( d, len( d ), replace=True ).mean() for _ in range( 4000 )] )
    lo, hi = np.percentile( boot, [2.5, 97.5] )
    print( f"\n  delta = {d.mean():+.4f}  95% CI [{lo:+.4f}, {hi:+.4f}]  "
           f"P(new better) = {(boot > 0).mean():.3f}  n={len(d)}" )


if __name__ == "__main__":
    main()
