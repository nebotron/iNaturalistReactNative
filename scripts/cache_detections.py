#!/usr/bin/env python3
"""
Run a model over every cached crop-log image once and store the raw (post-NMS,
pre-gate) detections to an .npz.

Inference is the only slow part of tuning; everything downstream (gate, union,
padding, squaring) is arithmetic. Caching the boxes turns a 40-minute variant
sweep into a two-second one.

Usage:
    python3 scripts/cache_detections.py MODEL.onnx OUT.npz [crop_training.json]
                                        [--slice first:last]
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image as PILImage

sys.path.insert( 0, str( Path( __file__ ).parent ) )
from evaluate_subject_detector import resolve_image, get_image_size

REPO_ROOT = Path( __file__ ).parent.parent
CACHE_DIR = Path( "/tmp/inat_eval_cache" )

YOLO_INPUT_SIZE = 640
YOLO_CONF_THRESH = 0.05
YOLO_IOU_THRESH = 0.45
MAX_DETS = 16

_sess = None
_model_path = None


def _init( model_path: str ) -> None:
    global _sess, _model_path
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    _sess = ort.InferenceSession( model_path, opts )
    _model_path = model_path


def _letterbox( img_arr: np.ndarray, size: int = YOLO_INPUT_SIZE ):
    img = PILImage.fromarray( img_arr )
    w, h = img.size
    scale = size / max( w, h )
    nw, nh = int( w * scale ), int( h * scale )
    resized = img.resize( ( nw, nh ), PILImage.BILINEAR )
    pad_left = ( size - nw ) // 2
    pad_top = ( size - nh ) // 2
    canvas = PILImage.new( "RGB", ( size, size ), ( 114, 114, 114 ) )
    canvas.paste( resized, ( pad_left, pad_top ) )
    return np.array( canvas ).astype( np.float32 ) / 255.0, pad_left, pad_top, scale


def _nms( boxes_xyxy: np.ndarray, scores: np.ndarray, iou_thresh: float ):
    order = np.argsort( scores )[::-1]
    kept = []
    while len( order ) > 0:
        i = order[0]
        kept.append( i )
        if len( order ) == 1:
            break
        x1 = np.maximum( boxes_xyxy[i, 0], boxes_xyxy[order[1:], 0] )
        y1 = np.maximum( boxes_xyxy[i, 1], boxes_xyxy[order[1:], 1] )
        x2 = np.minimum( boxes_xyxy[i, 2], boxes_xyxy[order[1:], 2] )
        y2 = np.minimum( boxes_xyxy[i, 3], boxes_xyxy[order[1:], 3] )
        inter = np.maximum( 0, x2 - x1 ) * np.maximum( 0, y2 - y1 )
        area_i = ( boxes_xyxy[i, 2] - boxes_xyxy[i, 0] ) * ( boxes_xyxy[i, 3] - boxes_xyxy[i, 1] )
        area_r = ( boxes_xyxy[order[1:], 2] - boxes_xyxy[order[1:], 0] ) * \
                 ( boxes_xyxy[order[1:], 3] - boxes_xyxy[order[1:], 1] )
        union = area_i + area_r - inter
        iou_arr = np.where( union > 0, inter / union, 0 )
        order = order[1:][iou_arr <= iou_thresh]
    return kept


def _detect( args ):
    idx, image_path, orig_w, orig_h = args
    try:
        img = PILImage.open( image_path ).convert( "RGB" )
        img_arr = np.array( img )
    except Exception:
        return idx, np.zeros( ( 0, 5 ), dtype=np.float32 )

    lb, pad_left, pad_top, scale = _letterbox( img_arr )
    x = lb.transpose( 2, 0, 1 )[None]
    out = _sess.run( None, { _sess.get_inputs()[0].name: x } )[0][0]

    if out.shape[0] == 5:
        cx, cy, w, h, conf_raw = out[0], out[1], out[2], out[3], out[4]
    else:
        cx, cy, w, h = out[0], out[1], out[2], out[3]
        conf_raw = out[4:].max( axis=0 )

    mask = conf_raw >= YOLO_CONF_THRESH
    if not mask.any():
        return idx, np.zeros( ( 0, 5 ), dtype=np.float32 )
    cx, cy, w, h, conf_raw = cx[mask], cy[mask], w[mask], h[mask], conf_raw[mask]
    boxes = np.stack( [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], axis=1 )
    kept = _nms( boxes, conf_raw, YOLO_IOU_THRESH )[:MAX_DETS]

    rows = []
    for i in kept:
        xn = max( 0.0, min( 1.0, ( float( boxes[i, 0] ) - pad_left ) / scale / orig_w ) )
        yn = max( 0.0, min( 1.0, ( float( boxes[i, 1] ) - pad_top ) / scale / orig_h ) )
        wn = max( 0.01, min( 1.0 - xn, ( float( boxes[i, 2] ) - float( boxes[i, 0] ) ) / scale / orig_w ) )
        hn = max( 0.01, min( 1.0 - yn, ( float( boxes[i, 3] ) - float( boxes[i, 1] ) ) / scale / orig_h ) )
        rows.append( ( xn, yn, wn, hn, float( conf_raw[i] ) ) )
    rows.sort( key=lambda r: r[4], reverse=True )
    return idx, np.array( rows, dtype=np.float32 ).reshape( -1, 5 )


def load_entries( json_path: Path ):
    """Returns (truths, image_paths, sizes, urls) for every resolvable log entry,
    in the log's own chronological order."""
    raw = json.loads( json_path.read_text() )
    out = []
    for e in raw:
        if not isinstance( e, dict ):
            continue
        c = e.get( "crop", e )
        if not all( k in c for k in ( "x", "y", "w", "h" ) ):
            continue
        url = e.get( "url", "" )
        p = resolve_image( url, None, CACHE_DIR )
        if not p:
            continue
        w, h = get_image_size( p )
        if not w or not h:
            continue
        out.append( ( ( c["x"], c["y"], c["w"], c["h"] ), p, ( w, h ), url ) )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument( "model" )
    ap.add_argument( "out" )
    ap.add_argument( "json", nargs="?", default=str( REPO_ROOT / "crop_training.json" ) )
    ap.add_argument( "--slice", default=None,
                     help="index range into the log, e.g. -1000: for the held-out tail" )
    args = ap.parse_args()

    model_path = str( Path( args.model ).resolve() )
    out_path = Path( args.out )

    entries = load_entries( Path( args.json ) )
    if args.slice:
        lo, _, hi = args.slice.partition( ":" )
        entries = entries[int( lo ) if lo else None:int( hi ) if hi else None]
    print( f"{len(entries)} resolvable entries", flush=True )

    tasks = [( i, str( p ), s[0], s[1] ) for i, ( _, p, s, _ ) in enumerate( entries )]
    results = [None] * len( tasks )
    with ProcessPoolExecutor( max_workers=4, initializer=_init, initargs=( model_path, ) ) as ex:
        for n, ( idx, dets ) in enumerate( ex.map( _detect, tasks, chunksize=16 ) ):
            results[idx] = dets
            if ( n + 1 ) % 500 == 0:
                print( f"  {n+1}/{len(tasks)}", flush=True )

    counts = np.array( [len( r ) for r in results], dtype=np.int32 )
    flat = np.concatenate( [r for r in results if len( r )] ) if counts.sum() else np.zeros( ( 0, 5 ), np.float32 )
    np.savez_compressed(
        out_path,
        counts=counts,
        dets=flat,
        truths=np.array( [e[0] for e in entries], dtype=np.float32 ),
        sizes=np.array( [e[2] for e in entries], dtype=np.int32 ),
        urls=np.array( [e[3] for e in entries] ),
        paths=np.array( [str( e[1] ) for e in entries] ),
    )
    print( f"Wrote {out_path} ({counts.sum()} detections over {len(counts)} images)" )


if __name__ == "__main__":
    main()
