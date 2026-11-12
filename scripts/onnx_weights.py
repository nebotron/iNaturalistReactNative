#!/usr/bin/env python3
"""
Store an ONNX model's weights smaller, in a form ONNX Runtime undoes at load.

  fp16  fp32 weights stored as fp16, each followed by a Cast back to fp32.
  int8  weights stored as int8 with one scale per output channel, followed by
        DequantizeLinear (-> Cast to fp16 for fp16 models).

ORT constant-folds those nodes while loading (basic optimizations, before
execution providers such as CoreML take their share of the graph), so the
session ends up with the same graph and weight types as before and only the
bundled file shrinks. ORT folds DequantizeLinear only with the session config
entry session.disable_quant_qdq = 1 (AudioBirdId.m sets it); without it the
weights stay int8 and are dequantized on every run instead. Folding costs a
transient ~100 MB more peak memory while the Audio ID session loads. Cast ->
Mul -> Cast folds without the setting but peaked ~370 MB higher.

Measured on the bundled models (2026-11):
  yolov8n.onnx    fp16: crop score identical on the newest 991 crop-log
                  images; int8 lost 0.013, so it is not used.
  audio_geo.onnx  int8: no Audio ID detection changed on 400 recordings.
  audio_id.onnx   int8 on the per-species heads only: no detection changed on
                  400 recordings or 327 labeled field clips. int8 on every
                  weight changed some, and int4 heads changed more.

Usage:
    python3 scripts/onnx_weights.py {fp16,int8} IN.onnx OUT.onnx [--prefix NAME ...]
"""
import argparse
import os

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

MIN_SIZE = 1024  # smaller tensors (and 1-D ones: biases, norms) stay as they are


def _candidates( graph, prefixes ):
    for t in graph.initializer:
        if t.data_type not in ( TensorProto.FLOAT, TensorProto.FLOAT16 ) or len( t.dims ) < 2:
            continue
        if int( np.prod( t.dims ) ) < MIN_SIZE:
            continue
        if prefixes and not t.name.startswith( tuple( prefixes ) ):
            continue
        yield t


def _output_axis( graph, name ):
    """The weight's output-channel axis: 1 for MatMul and untransposed Gemm, else 0."""
    for n in graph.node:
        if len( n.input ) > 1 and n.input[1] == name:
            if n.op_type == "MatMul":
                return 1
            if n.op_type == "Gemm":
                trans_b = any( a.name == "transB" and a.i for a in n.attribute )
                return 0 if trans_b else 1
    return 0


def _replace( graph, new_inits, new_nodes, replaced ):
    kept = [t for t in graph.initializer if t.name not in replaced]
    del graph.initializer[:]
    graph.initializer.extend( kept + new_inits )
    nodes = new_nodes + list( graph.node )
    del graph.node[:]
    graph.node.extend( nodes )


def store_fp16( model, prefixes=None ):
    g = model.graph
    inits, nodes, replaced = [], [], set( )
    for t in list( _candidates( g, prefixes ) ):
        if t.data_type != TensorProto.FLOAT:
            continue
        a = numpy_helper.to_array( t )
        inits.append( numpy_helper.from_array( a.astype( np.float16 ), f"{t.name}_fp16" ) )
        nodes.append( helper.make_node( "Cast", [f"{t.name}_fp16"], [t.name], to=TensorProto.FLOAT ) )
        replaced.add( t.name )
    _replace( g, inits, nodes, replaced )
    return len( replaced )


def store_int8( model, prefixes=None ):
    opset = next( o.version for o in model.opset_import if o.domain in ( "", "ai.onnx" ) )
    assert opset >= 13, "per-channel DequantizeLinear needs opset 13"
    g = model.graph
    inits, nodes, replaced = [], [], set( )
    for t in list( _candidates( g, prefixes ) ):
        a = numpy_helper.to_array( t )
        w = a.astype( np.float32 )
        axis = _output_axis( g, t.name )
        others = tuple( i for i in range( w.ndim ) if i != axis )
        scale = np.abs( w ).max( axis=others, keepdims=True ) / 127
        scale[scale == 0] = 1
        q = np.clip( np.round( w / scale ), -127, 127 ).astype( np.int8 )
        n = t.name
        inits += [numpy_helper.from_array( q, f"{n}_int8" ),
                  numpy_helper.from_array( scale.reshape( -1 ).astype( np.float32 ), f"{n}_scale" )]
        fp16 = t.data_type == TensorProto.FLOAT16
        product = f"{n}_fp32" if fp16 else n
        nodes.append( helper.make_node( "DequantizeLinear", [f"{n}_int8", f"{n}_scale"], [product],
                                        axis=axis ) )
        if fp16:
            nodes.append( helper.make_node( "Cast", [product], [n], to=TensorProto.FLOAT16 ) )
        replaced.add( n )
    _replace( g, inits, nodes, replaced )
    return len( replaced )


def stored_weights( graph ):
    """Every initializer as stored, with store_fp16's under their original names as float32."""
    out = {}
    for t in graph.initializer:
        a = numpy_helper.to_array( t )
        if t.name.endswith( "_fp16" ):
            out[t.name[:-len( "_fp16" )]] = a.astype( np.float32 )
        else:
            out[t.name] = a
    return out


def main( ):
    ap = argparse.ArgumentParser( description=__doc__.split( "\n\n" )[0] )
    ap.add_argument( "mode", choices=["fp16", "int8"] )
    ap.add_argument( "src" )
    ap.add_argument( "dst" )
    ap.add_argument( "--prefix", action="append", help="only weights whose names start with this" )
    args = ap.parse_args( )
    model = onnx.load( args.src )
    n = ( store_fp16 if args.mode == "fp16" else store_int8 )( model, args.prefix )
    onnx.checker.check_model( model )
    onnx.save( model, args.dst )
    print( f"{n} weights -> {args.mode}: {os.path.getsize( args.src ) / 1e6:.1f} MB -> "
           f"{os.path.getsize( args.dst ) / 1e6:.1f} MB" )


if __name__ == "__main__":
    main( )
