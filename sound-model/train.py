"""Train a small CNN species classifier on iNaturalist audio.

Sized to train on CPU in minutes. The reported number that matters is
recording-level accuracy on the recordist-disjoint validation split.
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
import time

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler

from common import DATA, N_FRAMES, N_MELS, RUNS

FEATURES = DATA / "features"


class WindowDataset( Dataset ):
    """One item per spectrogram window.

    Every window is held in one float16 array. At this scale that is a few
    hundred MB, which is cheaper than memory-mapping one file per recording —
    thousands of open maps would run into the open-file limit.
    """

    def __init__( self, rows, classes, train: bool, stats=None ):
        self.class_index = { name: i for i, name in enumerate( classes ) }
        self.train = train
        self.stats = stats

        specs, labels, recordings = [], [], []
        for r, row in enumerate( rows ):
            spec = np.load( FEATURES / row["features"] )
            label = self.class_index[row["scientific_name"]]
            specs.append( spec )
            labels += [label] * spec.shape[0]
            recordings += [r] * spec.shape[0]
        self.specs = np.concatenate( specs, axis=0 )
        self.labels = np.array( labels )
        self.recordings = np.array( recordings )

    def __len__( self ) -> int:
        return len( self.labels )

    def __getitem__( self, i ):
        x = torch.from_numpy( self.specs[i].astype( np.float32 ) )
        if self.stats is not None:
            x = ( x - self.stats[0] ) / self.stats[1]
        if self.train:
            x = augment( x )
        return x.unsqueeze( 0 ), int( self.labels[i] )


def augment( x: torch.Tensor ) -> torch.Tensor:
    """SpecAugment-style masking plus a circular time shift."""
    x = torch.roll( x, int( torch.randint( 0, x.shape[1], ( 1, ) ) ), dims=1 )
    for dim, max_width in ( ( 0, N_MELS // 8 ), ( 1, N_FRAMES // 8 ) ):
        width = int( torch.randint( 0, max_width + 1, ( 1, ) ) )
        if width:
            start = int( torch.randint( 0, x.shape[dim] - width + 1, ( 1, ) ) )
            index = [slice( None ), slice( None )]
            index[dim] = slice( start, start + width )
            x[tuple( index )] = 0.0
    return x


class AudioCNN( nn.Module ):
    def __init__( self, n_classes: int, widths=( 32, 64, 128, 256 ) ):
        super().__init__()
        blocks = []
        in_ch = 1
        for out_ch in widths:
            blocks += [
                nn.Conv2d( in_ch, out_ch, 3, padding=1, bias=False ),
                nn.BatchNorm2d( out_ch ),
                nn.ReLU( inplace=True ),
                nn.MaxPool2d( 2 ),
            ]
            in_ch = out_ch
        self.features = nn.Sequential( *blocks )
        self.head = nn.Sequential(
            nn.Dropout( 0.3 ), nn.Linear( in_ch * 2, n_classes )
        )

    def forward( self, x: torch.Tensor ) -> torch.Tensor:
        h = self.features( x )
        # Mean + max over the time-frequency plane: max catches short calls that
        # a mean over a mostly-empty window would wash out.
        pooled = torch.cat(
            [h.mean( dim=( 2, 3 ) ), h.amax( dim=( 2, 3 ) )], dim=1
        )
        return self.head( pooled )


def load_rows():
    with ( DATA / "features.csv" ).open() as fh:
        rows = list( csv.DictReader( fh ) )
    return (
        [r for r in rows if r["split"] == "train"],
        [r for r in rows if r["split"] == "val"],
    )


def compute_stats( specs: np.ndarray ) -> tuple[float, float]:
    """Normalization stats, accumulated in float32 over the float16 store."""
    return float( specs.mean( dtype=np.float32 ) ), float( specs.std( dtype=np.float32 ) + 1e-6 )


@torch.no_grad()
def evaluate( model, dataset, batch_size: int ):
    """Window-level and recording-level metrics on the validation split."""
    model.eval()
    loader = DataLoader( dataset, batch_size=batch_size, shuffle=False )
    logits = torch.cat( [model( xb ) for xb, _ in loader] )
    probs = F.softmax( logits, dim=1 )
    labels = torch.from_numpy( dataset.labels )

    window_acc = ( probs.argmax( 1 ) == labels ).float().mean().item()

    n_rec = int( dataset.recordings.max() ) + 1
    rec_probs = torch.zeros( n_rec, probs.shape[1] )
    rec_counts = torch.zeros( n_rec, 1 )
    rec_labels = torch.zeros( n_rec, dtype=torch.long )
    index = torch.from_numpy( dataset.recordings )
    rec_probs.index_add_( 0, index, probs )
    rec_counts.index_add_( 0, index, torch.ones( len( probs ), 1 ) )
    rec_labels[index] = labels
    rec_probs /= rec_counts.clamp( min=1 )

    pred = rec_probs.argmax( 1 )
    rec_acc = ( pred == rec_labels ).float().mean().item()
    top3 = rec_probs.topk( min( 3, rec_probs.shape[1] ), dim=1 ).indices
    top3_acc = ( top3 == rec_labels.unsqueeze( 1 ) ).any( 1 ).float().mean().item()

    f1s = []
    for c in range( rec_probs.shape[1] ):
        tp = int( ( ( pred == c ) & ( rec_labels == c ) ).sum() )
        fp = int( ( ( pred == c ) & ( rec_labels != c ) ).sum() )
        fn = int( ( ( pred != c ) & ( rec_labels == c ) ).sum() )
        f1s.append( 0.0 if tp == 0 else 2 * tp / ( 2 * tp + fp + fn ) )
    return {
        "window_acc": window_acc,
        "recording_acc": rec_acc,
        "recording_top3": top3_acc,
        "macro_f1": float( np.mean( f1s ) ),
    }


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__ )
    parser.add_argument( "--epochs", type=int, default=30 )
    parser.add_argument( "--batch-size", type=int, default=64 )
    parser.add_argument( "--lr", type=float, default=3e-3 )
    parser.add_argument( "--weight-decay", type=float, default=1e-2 )
    parser.add_argument( "--mixup", type=float, default=0.3 )
    parser.add_argument( "--threads", type=int, default=0 )
    args = parser.parse_args()

    if args.threads:
        torch.set_num_threads( args.threads )
    torch.manual_seed( 0 )

    train_rows, val_rows = load_rows()
    classes = sorted( { r["scientific_name"] for r in train_rows } )
    common = { r["scientific_name"]: r["common_name"] for r in train_rows }

    train_set = WindowDataset( train_rows, classes, train=True )
    # Stats come from train only, so nothing about the validation split leaks
    # into the normalization the model sees.
    stats = compute_stats( train_set.specs )
    train_set.stats = stats
    val_set = WindowDataset( val_rows, classes, train=False, stats=stats )
    print(
        f"{len( classes )} classes | {len( train_set )} train windows "
        f"({len( train_rows )} recordings) | {len( val_set )} val windows "
        f"({len( val_rows )} recordings)"
    )

    # Class-balanced sampling: iNat sound counts span an order of magnitude
    # between the commonest and rarest species in any top-N selection.
    freq = collections.Counter( train_set.labels.tolist() )
    weights = np.array( [1.0 / freq[int( y )] for y in train_set.labels] )
    sampler = WeightedRandomSampler( weights, len( weights ), replacement=True )

    model = AudioCNN( len( classes ) )
    n_params = sum( p.numel() for p in model.parameters() )
    print( f"AudioCNN with {n_params / 1e6:.2f}M parameters" )

    loader = DataLoader( train_set, batch_size=args.batch_size, sampler=sampler )
    optim = torch.optim.AdamW( model.parameters(), lr=args.lr, weight_decay=args.weight_decay )
    sched = torch.optim.lr_scheduler.OneCycleLR(
        optim, max_lr=args.lr, total_steps=args.epochs * len( loader ), pct_start=0.25
    )

    RUNS.mkdir( parents=True, exist_ok=True )
    best = { "recording_acc": -1.0 }
    history = []
    for epoch in range( 1, args.epochs + 1 ):
        model.train()
        started = time.time()
        total = 0.0
        for xb, yb in loader:
            if args.mixup > 0:
                lam = float( np.random.beta( args.mixup, args.mixup ) )
                perm = torch.randperm( xb.size( 0 ) )
                xb = lam * xb + ( 1 - lam ) * xb[perm]
                out = model( xb )
                loss = lam * F.cross_entropy( out, yb, label_smoothing=0.1 ) + (
                    1 - lam
                ) * F.cross_entropy( out, yb[perm], label_smoothing=0.1 )
            else:
                loss = F.cross_entropy( model( xb ), yb, label_smoothing=0.1 )
            optim.zero_grad( set_to_none=True )
            loss.backward()
            optim.step()
            sched.step()
            total += loss.item() * xb.size( 0 )

        metrics = evaluate( model, val_set, args.batch_size )
        history.append( { "epoch": epoch, "loss": total / len( train_set ), **metrics } )
        print(
            f"epoch {epoch:>3}  loss {total / len( train_set ):.3f}  "
            f"window {metrics['window_acc']:.3f}  recording {metrics['recording_acc']:.3f}  "
            f"top3 {metrics['recording_top3']:.3f}  f1 {metrics['macro_f1']:.3f}  "
            f"{time.time() - started:.0f}s"
        )
        if metrics["recording_acc"] > best["recording_acc"]:
            best = metrics
            torch.save(
                {
                    "state_dict": model.state_dict(),
                    "classes": classes,
                    "common_names": common,
                    "stats": stats,
                    "metrics": metrics,
                    "epoch": epoch,
                },
                RUNS / "model.pt",
            )

    ( RUNS / "history.json" ).write_text( json.dumps( history, indent=2 ) )
    print( f"\nBest: {json.dumps( best, indent=2 )}" )
    print( f"Chance level: {1 / len( classes ):.3f}" )


if __name__ == "__main__":
    main()
