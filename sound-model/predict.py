"""Run a trained checkpoint on an audio file and print the top species.

Example:
    python3 predict.py recording.mp3 --top 5
"""
from __future__ import annotations

import argparse

import torch
import torch.nn.functional as F

from common import RUNS, load_audio, log_mel, pick_windows
from train import AudioCNN


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__ )
    parser.add_argument( "audio" )
    parser.add_argument( "--checkpoint", default=str( RUNS / "model.pt" ) )
    parser.add_argument( "--top", type=int, default=5 )
    parser.add_argument( "--max-windows", type=int, default=16 )
    args = parser.parse_args()

    ckpt = torch.load( args.checkpoint, map_location="cpu", weights_only=False )
    classes = ckpt["classes"]
    mean, std = ckpt["stats"]

    model = AudioCNN( len( classes ) )
    model.load_state_dict( ckpt["state_dict"] )
    model.eval()

    windows = pick_windows( load_audio( args.audio ), args.max_windows )
    x = ( torch.from_numpy( log_mel( windows ) ) - mean ) / std
    with torch.no_grad():
        probs = F.softmax( model( x.unsqueeze( 1 ) ), dim=1 ).mean( dim=0 )

    print( f"{len( windows )} window(s) analyzed" )
    for score, index in zip( *probs.topk( min( args.top, len( classes ) ) ) ):
        name = classes[index]
        common = ckpt["common_names"].get( name, "" )
        label = f"{name} ({common})" if common else name
        print( f"  {score:.3f}  {label}" )


if __name__ == "__main__":
    main()
