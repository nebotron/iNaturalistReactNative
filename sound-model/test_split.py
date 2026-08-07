"""Checks on the dataset split, which is the easiest thing here to get wrong.

Run with: python3 -m unittest test_split -v
"""
from __future__ import annotations

import unittest

from preprocess import recordist_disjoint_split


def make_rows( spec: dict[int, list[str]] ) -> list[dict]:
    """spec maps user_id -> list of species names, one entry per recording."""
    return [
        { "user_id": str( user ), "scientific_name": name }
        for user, names in spec.items()
        for name in names
    ]


class RecordistDisjointSplitTest( unittest.TestCase ):
    def test_no_recordist_appears_on_both_sides( self ):
        rows = make_rows( { u: ["A", "B"] * 3 for u in range( 20 ) } )
        split, _ = recordist_disjoint_split( rows, val_frac=0.2, seed=0 )
        # A user maps to exactly one side by construction; assert the mapping is
        # total so no recording can silently land in both splits.
        self.assertEqual( set( split ), { int( r["user_id"] ) for r in rows } )
        self.assertTrue( set( split.values() ) <= { "train", "val" } )

    def test_both_splits_are_non_empty( self ):
        rows = make_rows( { u: ["A", "B", "C"] for u in range( 30 ) } )
        split, dropped = recordist_disjoint_split( rows, val_frac=0.2, seed=1 )
        self.assertEqual( dropped, [] )
        self.assertIn( "train", split.values() )
        self.assertIn( "val", split.values() )

    def test_repair_covers_a_species_held_by_few_recordists( self ):
        # "Rare" is held by only two recordists among many; a naive random split
        # would frequently leave it absent from validation.
        spec = { u: ["Common"] * 5 for u in range( 25 ) }
        spec[100] = ["Rare"] * 4
        spec[101] = ["Rare"] * 4
        rows = make_rows( spec )
        split, dropped = recordist_disjoint_split( rows, val_frac=0.2, seed=3 )
        self.assertEqual( dropped, [] )
        sides = { name: set() for name in ( "Common", "Rare" ) }
        for row in rows:
            sides[row["scientific_name"]].add( split[int( row["user_id"] )] )
        self.assertEqual( sides["Rare"], { "train", "val" } )
        self.assertEqual( sides["Common"], { "train", "val" } )

    def test_species_from_a_single_recordist_is_reported_as_dropped( self ):
        spec = { u: ["Common"] * 5 for u in range( 20 ) }
        spec[100] = ["Unsplittable"] * 3
        rows = make_rows( spec )
        _, dropped = recordist_disjoint_split( rows, val_frac=0.2, seed=0 )
        self.assertEqual( dropped, ["Unsplittable"] )

    def test_split_is_deterministic_for_a_seed( self ):
        rows = make_rows( { u: ["A", "B"] for u in range( 40 ) } )
        first, _ = recordist_disjoint_split( rows, val_frac=0.2, seed=7 )
        second, _ = recordist_disjoint_split( rows, val_frac=0.2, seed=7 )
        self.assertEqual( first, second )


if __name__ == "__main__":
    unittest.main()
