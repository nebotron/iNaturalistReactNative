import { speciesOutput, splitTaxon } from "components/AudioId/audioIdModel";

const SEATTLE = { latitude: 47.6, longitude: -122.3 };
const BOSTON = { latitude: 42.36, longitude: -71.06 };

describe( "splitTaxon", ( ) => {
  it( "gives a species iNaturalist hasn't split no taxon", ( ) => {
    expect( splitTaxon( "Turdus migratorius", SEATTLE ) ).toBeNull( );
  } );

  it( "gives a Marsh Wren the daughter species observed near the user", ( ) => {
    expect( splitTaxon( "Cistothorus palustris", SEATTLE )?.[1] ).toBe( "Cistothorus paludicola" );
    expect( splitTaxon( "Cistothorus palustris", BOSTON )?.[1] ).toBe( "Cistothorus palustris" );
  } );

  it( "gives a Warbling Vireo the daughter species observed near the user", ( ) => {
    expect( splitTaxon( "Vireo gilvus", SEATTLE )?.[1] ).toBe( "Vireo swainsoni" );
    expect( splitTaxon( "Vireo gilvus", BOSTON )?.[1] ).toBe( "Vireo gilvus" );
  } );

  it( "gives the taxon the daughters share without a location", ( ) => {
    const shared = splitTaxon( "Cistothorus palustris", null );
    expect( shared?.[1] ).not.toBe( "Cistothorus palustris" );
    expect( shared?.[1] ).not.toBe( "Cistothorus paludicola" );
  } );
} );

describe( "speciesOutput", ( ) => {
  it( "finds the model output of a species picked for a split one", ( ) => {
    const original = speciesOutput( {
      name: "Cistothorus palustris", commonName: "Marsh Wren", taxonId: 7601,
    } );
    expect( original ).toBeGreaterThanOrEqual( 0 );
    expect( speciesOutput( {
      name: "Cistothorus paludicola",
      commonName: "Western Marsh Wren",
      taxonId: 1721810,
      modelName: "Cistothorus palustris",
    } ) ).toBe( original );
  } );
} );
