"""Decode downloaded audio into log-mel windows and build a leak-free split.

The split is *recordist-disjoint*: every recording by a given iNaturalist user
lands entirely in train or entirely in validation. Splitting at the clip level
inflates accuracy badly on this data, because a single recordist often uploads
the same individual animal, at the same site, with the same microphone and
background, dozens of times.
"""
from __future__ import annotations

import argparse
import collections
import csv
import random

import numpy as np

from common import AUDIO, DATA, N_FRAMES, N_MELS, load_audio, log_mel, pick_windows

FEATURES = DATA / "features"


def build_features( rows: list[dict], max_windows: int ) -> list[dict]:
    FEATURES.mkdir( parents=True, exist_ok=True )
    out: list[dict] = []
    failures = 0
    for i, row in enumerate( rows, 1 ):
        dest = FEATURES / f"{row['sound_id']}.npy"
        if dest.exists():
            n = int( np.load( dest, mmap_mode="r" ).shape[0] )
        else:
            try:
                wav = load_audio( DATA / row["path"] )
                spec = log_mel( pick_windows( wav, max_windows ) )
            except Exception as err:  # corrupt or truncated uploads are common
                failures += 1
                print( f"  skip {row['path']}: {err}" )
                continue
            np.save( dest, spec.astype( np.float16 ) )
            n = spec.shape[0]
        out.append( { **row, "features": dest.name, "n_windows": n } )
        if i % 100 == 0:
            print( f"  {i}/{len( rows )} decoded" )
    print( f"Decoded {len( out )} recordings ({failures} unreadable)" )
    return out


def recordist_disjoint_split(
    rows: list[dict], val_frac: float, seed: int
) -> tuple[dict[int, str], list[str]]:
    """Assign whole recordists to train/val, then repair per-class coverage.

    Returns the user -> split map and the list of classes that could not be
    represented on both sides and must be dropped.
    """
    by_user = collections.defaultdict( list )
    for row in rows:
        by_user[int( row["user_id"] )].append( row )

    users = sorted( by_user )
    random.Random( seed ).shuffle( users )

    target = val_frac * len( rows )
    split = { u: "train" for u in users }
    n_val = 0
    for user in users:
        if n_val >= target:
            break
        split[user] = "val"
        n_val += len( by_user[user] )

    def class_counts() -> dict[str, collections.Counter]:
        counts: dict[str, collections.Counter] = {
            "train": collections.Counter(), "val": collections.Counter()
        }
        for user, side in split.items():
            for row in by_user[user]:
                counts[side][row["scientific_name"]] += 1
        return counts

    # Move whole recordists across to fix classes missing from one side. Moving
    # a complete recordist keeps the split disjoint by construction.
    for side, other in ( ( "val", "train" ), ( "train", "val" ) ):
        for _ in range( len( users ) ):
            counts = class_counts()
            missing = [
                name for name in counts[other]
                if counts[side][name] == 0 and counts[other][name] > 1
            ]
            if not missing:
                break
            name = missing[0]
            donors = [
                u for u in users
                if split[u] == other and any( r["scientific_name"] == name for r in by_user[u] )
            ]
            if len( donors ) < 2:
                break
            split[min( donors, key=lambda u: len( by_user[u] ) )] = side

    counts = class_counts()
    dropped = sorted(
        { r["scientific_name"] for r in rows }
        - { n for n in counts["train"] if counts["val"][n] > 0 }
    )
    return split, dropped


def main() -> None:
    parser = argparse.ArgumentParser( description=__doc__ )
    parser.add_argument( "--max-windows", type=int, default=4,
                         help="most active windows kept per recording" )
    parser.add_argument( "--val-frac", type=float, default=0.2 )
    parser.add_argument( "--seed", type=int, default=0 )
    parser.add_argument( "--min-per-class", type=int, default=20 )
    args = parser.parse_args()

    with ( DATA / "manifest.csv" ).open() as fh:
        rows = list( csv.DictReader( fh ) )
    rows = [r for r in rows if ( AUDIO / r["path"].split( "/" )[-1] ).exists()]
    print( f"Manifest: {len( rows )} recordings" )

    rows = build_features( rows, args.max_windows )

    per_class = collections.Counter( r["scientific_name"] for r in rows )
    rows = [r for r in rows if per_class[r["scientific_name"]] >= args.min_per_class]

    split, dropped = recordist_disjoint_split( rows, args.val_frac, args.seed )
    if dropped:
        print( f"Dropping {len( dropped )} class(es) without both-side coverage: {dropped}" )
        rows = [r for r in rows if r["scientific_name"] not in dropped]
        split, _ = recordist_disjoint_split( rows, args.val_frac, args.seed )

    for row in rows:
        row["split"] = split[int( row["user_id"] )]

    out = DATA / "features.csv"
    with out.open( "w", newline="" ) as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "features", "n_windows", "split", "scientific_name", "common_name",
                "taxon_id", "observation_id", "user_id", "sound_id", "license_code",
            ],
            extrasaction="ignore",
        )
        writer.writeheader()
        writer.writerows( rows )

    counts = collections.Counter( ( r["scientific_name"], r["split"] ) for r in rows )
    windows = collections.Counter( r["split"] for r in rows for _ in range( r["n_windows"] ) )
    print( f"\n{'species':<34}{'train':>7}{'val':>7}" )
    for name in sorted( { r['scientific_name'] for r in rows } ):
        print( f"{name:<34}{counts[( name, 'train' )]:>7}{counts[( name, 'val' )]:>7}" )
    print(
        f"\n{len( rows )} recordings, "
        f"{windows['train']} train / {windows['val']} val windows "
        f"of {N_MELS}x{N_FRAMES}"
    )
    print(
        f"Recordists: {len( { r['user_id'] for r in rows if r['split'] == 'train' } )} train / "
        f"{len( { r['user_id'] for r in rows if r['split'] == 'val' } )} val (disjoint)"
    )
    print( f"Wrote {out}" )


if __name__ == "__main__":
    main()
