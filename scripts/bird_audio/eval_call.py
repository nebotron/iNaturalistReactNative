#!/usr/bin/env python3
"""
Backtest the call-only score (callConfidence) against the live window score.

For each labeled 15 s Audio ID clip (see eval_clips.py), replays what the app
does once a call is heard:
  live   the centered 5 s window, as the live run scored it
  call   the timeline (frame logits from 5 s runs every 2.5 s), findCall's
         span (audioIdSession.ts), that span re-encoded to AAC as trimClip
         does, then scored as scoreSound does (5 s windows every 2.5 s, max,
         padded with silence)
and reports how many right and wrong detections each score, and combinations
of them, would still report at a range of thresholds. Clips are cached as in
eval_clips.py, scores in --cache per clip and model.

  python3 scripts/bird_audio/eval_call.py
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import onnxruntime as ort

sys.path.insert( 0, os.path.dirname( os.path.abspath( __file__ ) ) )
from eval_clips import ROOT, SR, WIN, get, load_clip  # noqa: E402

# tunableParams.ts
CALL_LOGIT, CALL_PEAK_RANGE, CALL_GAP_S, CALL_PADDING_BINS, MIN_CALL_S = 0, 2, 2, 1, 1
BINS_PER_S, CONTEXT_S = 3, 15
WINDOW_BINS = ( 5 * BINS_PER_S, 10 * BINS_PER_S - 1 )
CALL_GAP_BINS = round( CALL_GAP_S * BINS_PER_S )


def find_call( bins ):
    """findCall in audioIdSession.ts."""
    bins = [-np.inf if b is None else b for b in bins]
    peak = max( bins[WINDOW_BINS[0]:WINDOW_BINS[1] + 1] )
    if not np.isfinite( peak ):
        return None
    on = min( CALL_LOGIT, peak - CALL_PEAK_RANGE )
    stretches = []
    for i, b in enumerate( bins ):
        if b < on:
            continue
        if stretches and i - stretches[-1][1] <= CALL_GAP_BINS + 1:
            stretches[-1][1] = i
        else:
            stretches.append( [i, i] )
    cands = [s for s in stretches if s[1] >= WINDOW_BINS[0] and s[0] <= WINDOW_BINS[1]]
    if not cands:
        return None
    a, b = max( cands, key=lambda s: max( bins[s[0]:s[1] + 1] ) )
    start = max( 0, ( a - CALL_PADDING_BINS ) / BINS_PER_S )
    end = min( CONTEXT_S, ( b + 1 + CALL_PADDING_BINS ) / BINS_PER_S )
    if end - start < MIN_CALL_S:
        half = MIN_CALL_S / 2
        mid = min( max( ( start + end ) / 2, half ), CONTEXT_S - half )
        start, end = mid - half, mid + half
    return start, end


def windows_every_half( x ):
    """Starts of 5 s windows every 2.5 s, the last ending at the end (scoreSound)."""
    length = max( len( x ), WIN )
    x = np.pad( x, ( 0, length - len( x ) ) )
    starts, s = [], 0
    while True:
        last = s + WIN >= length
        if last:
            s = length - WIN
        starts.append( s )
        if last:
            return x, starts
        s += WIN // 2


def aac_roundtrip( x ):
    with tempfile.TemporaryDirectory( ) as d:
        raw, m4a, out = ( os.path.join( d, n ) for n in ( "in.f32", "c.m4a", "out.f32" ) )
        x.astype( np.float32 ).tofile( raw )
        subprocess.run( ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str( SR ), "-ac", "1",
                         "-i", raw, "-c:a", "aac", "-b:a", "64k", m4a], check=True )
        subprocess.run( ["ffmpeg", "-v", "error", "-y", "-i", m4a, "-ac", "1", "-ar", str( SR ),
                         "-f", "f32le", out], check=True )
        return np.fromfile( out, np.float32 )


def main( ):
    ap = argparse.ArgumentParser( description=__doc__.split( "\n\n" )[0] )
    ap.add_argument( "--cache", default="/tmp/audio_id_clips" )
    args = ap.parse_args( )
    os.makedirs( args.cache, exist_ok=True )

    labels = get( "audio_id_labels" )
    for lab in labels.values( ):
        lab["correct"] = lab.get( "labelTaxonId" ) == lab["predictedTaxonId"]
    species = json.load( open( os.path.join( ROOT, "src/components/AudioId/audioIdSpecies.json" ) ) )
    index = {sp[2]: i for i, sp in enumerate( species )}
    model = os.path.join( ROOT, "ios/iNaturalistReactNative/audio_id.onnx" )
    h = hashlib.sha1( b"call1" )
    for f in sorted( os.listdir( os.path.dirname( model ) ) ):
        if f.startswith( "audio_id." ):
            with open( os.path.join( os.path.dirname( model ), f ), "rb" ) as fh:
                h.update( fh.read( ) )
    model_key = h.hexdigest( )[:12]
    clip_ids = [c for c in sorted( get( "audio_id_clips", shallow=True ) )
                if c in labels and labels[c]["predictedTaxonId"] in index]
    with ThreadPoolExecutor( 8 ) as pool:
        list( pool.map( lambda c: load_clip( c, args.cache ), clip_ids ) )

    session = None
    rows = []
    for clip_id in clip_ids:
        pcm = np.fromfile( os.path.join( args.cache, f"{clip_id}.f32" ), np.float32 )
        if len( pcm ) < 12 * SR:
            continue  # only 15 s clips have the context the call is found in
        lab = labels[clip_id]
        k = index[lab["predictedTaxonId"]]
        cached = os.path.join( args.cache, f"{clip_id}.{model_key}.call.json" )
        if os.path.exists( cached ):
            r = json.load( open( cached ) )
        else:
            session = session or ort.InferenceSession( model )
            # The 15 s centered on the live window, as saveClip keeps it.
            mid = len( pcm ) // 2
            x = pcm[max( 0, mid - CONTEXT_S * SR // 2 ):][:CONTEXT_S * SR]
            x, starts = windows_every_half( x )
            out, frames = session.run( ["output", "frames"],
                                       {"input": np.stack( [x[s:s + WIN] for s in starts] )} )
            live = float( out[starts.index( WIN )] [k] ) if WIN in starts else None
            nbins = round( CONTEXT_S * BINS_PER_S )
            tot, cnt = np.zeros( nbins ), np.zeros( nbins )
            t = frames.shape[2]
            for j, s in enumerate( starts ):
                for i in range( t ):
                    b = int( np.floor( ( s + ( i + 0.5 ) * WIN / t ) / ( SR / BINS_PER_S ) ) )
                    if 0 <= b < nbins:
                        tot[b] += frames[j, k, i]
                        cnt[b] += 1
            timeline = [tot[b] / cnt[b] if cnt[b] else None for b in range( nbins )]
            span = find_call( timeline )
            call = raw_call = None
            if span:
                seg = x[int( span[0] * SR ):int( span[1] * SR )]
                for name, audio in ( ( "raw", seg ), ( "aac", aac_roundtrip( seg ) ) ):
                    y, st = windows_every_half( audio )
                    sc = session.run( ["output"], {"input": np.stack( [y[s:s + WIN] for s in st] )} )
                    best = float( sc[0][:, k].max( ) )
                    if name == "raw":
                        raw_call = best
                    else:
                        call = best
            r = {"live": live, "call": call, "rawCall": raw_call, "span": span}
            json.dump( r, open( cached, "w" ) )
        r.update( id=clip_id, correct=lab["correct"], logged=lab["confidence"],
                  loggedCall=lab.get( "callConfidence" ), name=species[k][1],
                  label=lab.get( "labelName" ) or ( "no organism" if lab.get( "noOrganism" )
                                                    else "wrong ID" ) )
        rows.append( r )

    right = sum( r["correct"] for r in rows )
    print( f"{len( rows )} labeled 15 s clips: {right} right, {len( rows ) - right} wrong; "
           f"call found in {sum( r['span'] is not None for r in rows )}" )
    print( f"call span median {np.median( [r['span'][1] - r['span'][0] for r in rows if r['span']] ):.1f} s" )
    c = [r for r in rows if r["loggedCall"] is not None and r["call"] is not None]
    if c:
        d = np.abs( [r["call"] - r["loggedCall"] for r in c] )
        print( f"replayed call vs app's callConfidence on {len( c )}: |d| mean {d.mean( ):.3f}, "
               f"median {np.median( d ):.3f}" )
    d = np.abs( [r["live"] - r["logged"] for r in rows if r["live"] is not None] )
    print( f"replayed live vs logged confidence: |d| mean {d.mean( ):.3f}, median {np.median( d ):.3f}" )

    def z( v ):
        return 0.0 if v is None else v
    scores = {
        "logged": lambda r: r["logged"],
        "live": lambda r: z( r["live"] ),
        "call": lambda r: z( r["call"] ),
        "callRaw": lambda r: z( r["rawCall"] ),
        "logged&call": lambda r: min( r["logged"], z( r["call"] ) ),
        "mean": lambda r: ( r["logged"] + z( r["call"] ) ) / 2,
    }

    def auc( f, rs ):
        R = [f( r ) for r in rs if r["correct"]]
        W = [f( r ) for r in rs if not r["correct"]]
        return sum( ( a > b ) + 0.5 * ( a == b ) for a in R for b in W ) / max( 1, len( R ) * len( W ) )

    # Only what the app reports at 0.5 on the live window, as the gate would see it.
    reported = [r for r in rows if r["logged"] >= 0.5]
    print( f"\nReported live (logged >= 0.5): {sum( r['correct'] for r in reported )} right, "
           f"{sum( not r['correct'] for r in reported )} wrong" )
    print( "AUC over reported: " + ", ".join( f"{n} {auc( f, reported ):.3f}"
                                             for n, f in scores.items( ) ) )
    print( "\nStill reported among those (right / wrong):" )
    ths = ( 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7 )
    print( f"{'':12}" + "".join( f"{t:>10}" for t in ths ) )
    for n, f in scores.items( ):
        cells = []
        for t in ths:
            kept = [r for r in reported if f( r ) >= t]
            cells.append( f"{sum( r['correct'] for r in kept )}/{sum( not r['correct'] for r in kept )}" )
        print( f"{n:12}" + "".join( f"{c:>10}" for c in cells ) )

    print( "\nRight detections the call would drop at 0.5:" )
    for r in sorted( reported, key=lambda r: z( r["call"] ) ):
        if r["correct"] and z( r["call"] ) < 0.5:
            span = r["span"] and f"{r['span'][0]:.1f}-{r['span'][1]:.1f}s"
            print( f"  {r['id'][:8]} {r['name'][:24]:24} logged {r['logged']:.2f} "
                   f"call {z( r['call'] ):.2f} raw {z( r['rawCall'] ):.2f} span {span}" )


if __name__ == "__main__":
    main( )
