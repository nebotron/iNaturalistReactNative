import { speciesIdFromTaxon } from "sharedHelpers/observationHistory";

describe( "speciesIdFromTaxon", ( ) => {
  it( "is the taxon itself at species level", ( ) => {
    expect( speciesIdFromTaxon( { id: 3017, rank_level: 10 } ) ).toEqual( 3017 );
  } );

  it( "is the hybrid itself for a hybrid or genus hybrid", ( ) => {
    expect( speciesIdFromTaxon( {
      id: 326092,
      rank: "hybrid",
      rank_level: 10,
      ancestor_ids: [48460, 1, 6912, 545975, 326092],
    } ) ).toEqual( 326092 );
    expect( speciesIdFromTaxon( {
      id: 545975,
      rank: "genushybrid",
      rank_level: 20,
      ancestor_ids: [48460, 1, 6912, 545975],
    } ) ).toEqual( 545975 );
  } );

  it( "is the parent species for a subspecies, variety, or form", ( ) => {
    expect( speciesIdFromTaxon( {
      id: 122767,
      rank_level: 5,
      ancestor_ids: [3, 2708, 2715, 3000, 3017, 122767],
    } ) ).toEqual( 3017 );
  } );

  it( "is nothing for an identification coarser than a species", ( ) => {
    expect( speciesIdFromTaxon( {
      id: 3000,
      rank_level: 20,
      ancestor_ids: [3, 2708, 2715, 3000],
    } ) ).toBeNull( );
  } );

  // Nothing to roll up to, so it can't count as any species in particular.
  it( "is nothing for a below-species taxon with no ancestry", ( ) => {
    expect( speciesIdFromTaxon( { id: 122767, rank_level: 5 } ) ).toBeNull( );
  } );

  it( "is nothing without a taxon", ( ) => {
    expect( speciesIdFromTaxon( null ) ).toBeNull( );
    expect( speciesIdFromTaxon( { id: 3017 } ) ).toBeNull( );
  } );
} );
