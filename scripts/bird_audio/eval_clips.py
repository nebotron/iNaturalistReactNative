#!/usr/bin/env python3
"""
Evaluate Audio ID on the clips users labeled in the app.

Labels are in Firebase at audio_id_labels/<id>, the 5 s AAC clip at
audio_id_clips/<id> (only from builds with 3b430e1 on). Clips are cached in
--cache, decoded to 32 kHz mono with ffmpeg and run through
ios/iNaturalistReactNative/audio_id.onnx. Per clip it prints the logged
confidence and the predicted species' score under each variant below, then how
many right and wrong detections each variant would still report.

  python3 scripts/bird_audio/eval_clips.py

Variants (score of the predicted species):
  raw    window at offset 0 (AAC priming shifts it a few ms from the app's)
  mean3  mean over offsets 0, 7, 13 ms
  min3   min over those offsets
  nbr    max of the runs 1 s earlier / later; 15 s clips (newer builds) have
         the real audio around the centered window, 5 s ones pad with
         silence, so there it reads low
  both   mean3 if nbr also clears the threshold, else 0
Scores are cached in --cache per clip and model, so reruns only score new clips.
"""
import argparse
import base64
import glob
import hashlib
import json
import os
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import onnxruntime as ort

ROOT = os.path.dirname( os.path.dirname( os.path.dirname( os.path.abspath( __file__ ) ) ) )
sys.path.insert( 0, os.path.join( ROOT, "scripts" ) )
from firebase_auth import firebase_auth_query, firebase_base_url  # noqa: E402

SR = 32000
WIN = 5 * SR
THRESHOLD = 0.5  # audioIdSession.ts
OFFSETS = ( 0, 213, 427 )


def get( path, shallow=False ):
    auth = firebase_auth_query( )
    query = "&".join( q for q in ( auth.lstrip( "?" ), "shallow=true" if shallow else "" ) if q )
    url = f"{firebase_base_url( )}/{path}.json" + ( f"?{query}" if query else "" )
    with urllib.request.urlopen( url ) as r:
        return json.load( r ) or {}


def load_clip( clip_id, cache ):
    pcm = os.path.join( cache, f"{clip_id}.f32" )
    if not os.path.exists( pcm ):
        m4a = os.path.join( cache, f"{clip_id}.m4a" )
        audio = get( f"audio_id_clips/{clip_id}" )["audioBase64"]
        with open( m4a, "wb" ) as f:
            f.write( base64.b64decode( audio ) )
        subprocess.run( ["ffmpeg", "-v", "error", "-y", "-i", m4a, "-ac", "1", "-ar", str( SR ),
                         "-f", "f32le", pcm], check=True )
    x = np.fromfile( pcm, np.float32 )
    # A 15 s clip is centered on the detection's window; pad a 5 s one with a
    # second of silence on each side.
    start = ( len( x ) - WIN ) // 2 if len( x ) > WIN + 2 * SR else 0
    x = x[start - SR:] if start else np.pad( x, ( SR, 0 ) )
    return np.pad( x, ( 0, max( 0, 2 * SR + WIN + OFFSETS[-1] - len( x ) ) ) )


def main( ):
    ap = argparse.ArgumentParser( description=__doc__.split( "\n\n" )[0] )
    ap.add_argument( "--cache", default="/tmp/audio_id_clips" )
    args = ap.parse_args( )
    os.makedirs( args.cache, exist_ok=True )

    labels = get( "audio_id_labels" )
    for lab in labels.values( ):
        lab["correct"] = lab.get( "labelTaxonId" ) == lab["predictedTaxonId"]
    right = sum( lab["correct"] for lab in labels.values( ) )
    no_org = sum( bool( lab.get( "noOrganism" ) ) for lab in labels.values( ) )
    print( f"{len( labels )} labels: {right} right, {len( labels ) - right} wrong "
           f"({no_org} with no organism) -> precision {right / max( 1, len( labels ) ):.2f}" )

    species = json.load( open( os.path.join( ROOT, "src/components/AudioId/audioIdSpecies.json" ) ) )
    index = {sp[2]: i for i, sp in enumerate( species )}
    model = os.path.join( ROOT, "ios/iNaturalistReactNative/audio_id.onnx" )
    h = hashlib.sha1( repr( OFFSETS ).encode( ) )
    for f in sorted( glob.glob( model[:-len( ".onnx" )] + ".*" ) ):
        with open( f, "rb" ) as fh:
            h.update( fh.read( ) )
    model_key = h.hexdigest( )[:12]
    session = None
    clip_ids = sorted( get( "audio_id_clips", shallow=True ) )
    print( f"{len( clip_ids )} have audio\n" )
    with ThreadPoolExecutor( 8 ) as pool:
        list( pool.map( lambda c: load_clip( c, args.cache ),
                        [c for c in clip_ids if c in labels] ) )

    names = ["raw", "mean3", "min3", "nbr", "both"]
    print( f"{'clip':8} {'ok':2} {'species':22} {'log':>5} " + " ".join( f"{n:>5}" for n in names )
           + "  dBFS  label" )
    tally = {n: [0, 0] for n in names}  # [right, wrong] still reported
    for clip_id in clip_ids:
        lab = labels.get( clip_id )
        if not lab or lab["predictedTaxonId"] not in index:
            continue
        k = index[lab["predictedTaxonId"]]
        x = load_clip( clip_id, args.cache )
        scores = os.path.join( args.cache, f"{clip_id}.{model_key}.npy" )
        if not os.path.exists( scores ):
            session = session or ort.InferenceSession( model )
            windows = [x[SR + o:SR + o + WIN] for o in OFFSETS] + [x[:WIN], x[2 * SR:2 * SR + WIN]]
            np.save( scores, session.run( ["output"], {"input": np.stack( windows )} )[0] )
        s = np.load( scores )[:, k]
        mean3 = s[:3].mean( )
        nbr = s[3:].max( )
        v = {"raw": s[0], "mean3": mean3, "min3": s[:3].min( ), "nbr": nbr,
             "both": mean3 if nbr >= THRESHOLD else 0}
        for n in names:
            if v[n] >= THRESHOLD:
                tally[n][0 if lab["correct"] else 1] += 1
        label = "no organism" if lab.get( "noOrganism" ) else lab.get( "labelName" ) or "wrong ID"
        db = 20 * np.log10( np.abs( x[SR:SR + WIN] ).max( ) + 1e-9 )
        print( f"{clip_id[:8]:8} {'Y' if lab['correct'] else 'N':2} {species[k][1][:22]:22} "
               f"{lab['confidence']:5.2f} " + " ".join( f"{v[n]:5.2f}" for n in names )
               + f"  {db:4.0f}  {label}" )

    print( f"\nStill reported at {THRESHOLD} (right kept / wrong kept):" )
    for n in names:
        print( f"  {n:6} {tally[n][0]:3} / {tally[n][1]}" )


if __name__ == "__main__":
    main( )
