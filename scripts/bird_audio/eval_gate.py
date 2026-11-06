#!/usr/bin/env python3
"""
Would an activity gate have skipped any labeled Audio ID detection?

The gate under test: Audio ID runs its model every second only while the 5 s
window holds some sound above the background, and every few seconds otherwise.
"Above the background" uses the live spectrogram's own noise tracker
(ABSpectrogramColumn in AudioBirdId.m, replicated here): a column is active
when at least K of its 250 Hz-12 kHz bins stand T dB above their noise floor,
and a window is active when any of its columns is.

For every labeled clip (see eval_clips.py, whose cache this reuses) it checks
whether the detection's own window was active, i.e. whether the gate would
still have run the model when the app did. Right detections in inactive
windows are the ones the gate puts at risk; wrong ones are false positives it
would mostly remove. It also reports the share of 1 s steps in the clips that
were inactive -- a floor on the savings, since clips only exist around
detections.

  python3 scripts/bird_audio/eval_gate.py [--cache DIR]
"""
import argparse
import glob
import json
import os
import sys

import numpy as np

sys.path.insert( 0, os.path.dirname( os.path.abspath( __file__ ) ) )
from eval_clips import get, load_clip  # noqa: E402

SR = 32000
WIN = 5 * SR
HOP = 400        # AB_SPEC_HOP
N = 1024         # AB_SPEC_N
LO, H = 8, 376   # AB_SPEC_LO, AB_SPEC_H
THRESHOLDS_DB = ( 6, 10, 15, 20 )
MIN_BINS = ( 1, 3, 10 )


def levels_above_noise( x ):
    """dB above the tracked noise floor, [columns, bins], as AudioBirdId.m."""
    hann = 0.5 * ( 1 - np.cos( 2 * np.pi * np.arange( N ) / N ) )  # vDSP_HANN_DENORM
    ends = np.arange( N, len( x ) + 1, HOP )
    frames = np.stack( [x[e - N:e] for e in ends] ) * hann
    # vDSP_fft_zrip doubles the DFT
    power = 4 * np.abs( np.fft.rfft( frames, axis=1 ) ) ** 2
    db = 10 * np.log10( power[:, LO:LO + H] / ( N * N ) + 1e-12 )
    noise = np.full( H, np.nan )

    def track( out ):
        nonlocal noise
        for i, d in enumerate( db ):
            noise = np.where( np.isnan( noise ), d, noise )
            rate = np.where( d > noise, 0.004, 0.05 )
            noise = np.where( d > -110, noise + rate * ( d - noise ), noise )
            noise = np.maximum( noise, -100 )
            if out is not None:
                out[i] = d - noise
    # A first pass settles the floor, as minutes of listening would have.
    track( None )
    above = np.empty_like( db )
    track( above )
    return ends, above


def main( ):
    ap = argparse.ArgumentParser( description=__doc__.split( "\n\n" )[0] )
    ap.add_argument( "--cache", default="/tmp/audio_id_clips" )
    args = ap.parse_args( )
    labels = get( "audio_id_labels" )
    root = os.path.dirname( os.path.dirname( os.path.dirname( os.path.abspath( __file__ ) ) ) )
    species = json.load( open( os.path.join( root, "src/components/AudioId/audioIdSpecies.json" ) ) )
    index = {sp[2]: i for i, sp in enumerate( species )}

    rows = []
    quiet_steps = {( t, k ): [0, 0] for t in THRESHOLDS_DB for k in MIN_BINS}
    for pcm in sorted( glob.glob( os.path.join( args.cache, "*.f32" ) ) ):
        clip_id = os.path.basename( pcm )[:-4]
        lab = labels.get( clip_id )
        if not lab or lab["predictedTaxonId"] not in index:
            continue
        load_clip( clip_id, args.cache )
        x = np.fromfile( pcm, np.float32 )
        long_clip = len( x ) > WIN + 2 * SR
        start = ( len( x ) - WIN ) // 2 if long_clip else 0
        ends, above = levels_above_noise( x )
        in_window = ( ends > start ) & ( ends <= start + WIN )
        row = {"right": lab.get( "labelTaxonId" ) == lab["predictedTaxonId"],
               "reported": lab["confidence"] >= 0.5, "long": long_clip}
        for t in THRESHOLDS_DB:
            for k in MIN_BINS:
                active = ( above >= t ).sum( axis=1 ) >= k
                row[( t, k )] = bool( active[in_window].any( ) )
                if long_clip:
                    # Every 1 s step whose trailing 5 s window lies in the clip
                    for end in range( WIN, len( x ) + 1, SR ):
                        w = ( ends > end - WIN ) & ( ends <= end )
                        quiet_steps[( t, k )][0] += not active[w].any( )
                        quiet_steps[( t, k )][1] += 1
        rows.append( row )

    reported = [r for r in rows if r["reported"]]
    right = [r for r in reported if r["right"]]
    wrong = [r for r in reported if not r["right"]]
    print( f"{len( rows )} labeled clips with audio; reported at 0.5: "
           f"{len( right )} right, {len( wrong )} wrong\n" )
    print( f"{'T dB':>5} {'K bins':>6}  {'right in quiet window':>22}  "
           f"{'wrong in quiet window':>22}  {'quiet 1 s steps (15 s clips)':>28}" )
    for t in THRESHOLDS_DB:
        for k in MIN_BINS:
            r_q = sum( not r[( t, k )] for r in right )
            w_q = sum( not r[( t, k )] for r in wrong )
            q, n = quiet_steps[( t, k )]
            print( f"{t:5} {k:6}  {r_q:12} of {len( right ):<6}  {w_q:12} of {len( wrong ):<6}  "
                   f"{q:14} of {n} ({100 * q / max( n, 1 ):.0f}%)" )


if __name__ == "__main__":
    main( )
