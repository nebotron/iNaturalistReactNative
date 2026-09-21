#!/usr/bin/env python3
"""
Score a training checkpoint with the crop metric, not with mAP.

ultralytics picks `best.pt` by validation fitness, which is mAP — a metric the
app never uses and that ranks checkpoints differently from the weighted
recall/precision score the crop actually gets judged on. This exports a
checkpoint, runs it over a slice of the log, and reports the real score at each
gate, so checkpoint choice is made on the metric that ships.

Usage:
    python3 scripts/score_checkpoint.py WEIGHTS.pt [--slice -1000:] [--keep OUT.onnx]
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert( 0, str( Path( __file__ ).parent ) )

REPO_ROOT = Path( __file__ ).parent.parent


def export( weights: Path, dest: Path ) -> Path:
    from ultralytics import YOLO
    out = Path( YOLO( str( weights ) ).export( format="onnx", imgsz=640, dynamic=False,
                                               simplify=True, opset=12 ) )
    if out.resolve() != dest.resolve():
        shutil.copy2( out, dest )
    return dest


def verify_export( weights: Path, onnx_path: Path ) -> None:
    """The export has its own chance to change the graph; make it prove it did not."""
    import torch
    import onnxruntime as ort
    ckpt = torch.load( str( weights ), weights_only=False )
    # Training checkpoints carry the EMA weights and leave "model" empty; the
    # EMA is what export uses, so it is what has to be verified.
    model = ( ckpt.get( "ema" ) or ckpt["model"] ).float().eval()
    x = np.random.default_rng( 0 ).random( ( 1, 3, 640, 640 ), dtype=np.float32 )
    with torch.no_grad():
        ref = model( torch.from_numpy( x ) )
    ref = ( ref[0] if isinstance( ref, ( list, tuple ) ) else ref ).numpy()
    sess = ort.InferenceSession( str( onnx_path ), providers=["CPUExecutionProvider"] )
    got = sess.run( None, { sess.get_inputs()[0].name: x } )[0]
    diff = float( np.abs( got - ref ).max() )
    print( f"export matches the checkpoint to {diff:.6f}" )
    if diff > 1e-2:
        sys.exit( "Exported ONNX does not match the checkpoint — aborting." )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "weights" )
    ap.add_argument( "--slice", default="-1000:" )
    ap.add_argument( "--keep", default=None, help="where to keep the exported ONNX" )
    ap.add_argument( "--npz", default=None, help="where to keep the detection cache" )
    args = ap.parse_args()

    weights = Path( args.weights )
    tmp = Path( tempfile.mkdtemp() )
    onnx_path = Path( args.keep ) if args.keep else tmp / "model.onnx"
    npz = Path( args.npz ) if args.npz else tmp / "dets.npz"

    export( weights, onnx_path )
    verify_export( weights, onnx_path )

    cmd = [sys.executable, str( REPO_ROOT / "scripts/cache_detections.py" ),
           str( onnx_path ), str( npz )]
    if args.slice:
        cmd += [f"--slice={args.slice}"]  # a leading -1000: would read as a flag
    subprocess.run( cmd, check=True )

    from sweep_crop import load, saliency_for, bounds_array, score
    dets, truths, sizes, urls, paths = load( npz )
    sal = saliency_for( paths )
    print( f"\n{weights}  ({len(dets)} images)" )
    best = ( -1.0, None )
    for g in [0.30, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70]:
        s, r, p, ok = score( bounds_array( dets, sal, g ), truths, sizes, 0.0 )
        print( f"  gate={g:.2f}  recall={r.mean():.4f}  prec={p.mean():.4f}  score={s.mean():.4f}" )
        if s.mean() > best[0]:
            best = ( float( s.mean() ), g )
    print( f"  best: gate={best[1]:.2f} score={best[0]:.4f}" )


if __name__ == "__main__":
    main()
