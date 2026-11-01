import loadBirdCodes from "sharedHelpers/loadBirdCodes";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

jest.mock( "appConstants/birdCodes.json", ( ) => [
  [7089, "Branta canadensis", "Canada Goose", "species", 10, [48460, 1, 3, 7089], ["CANG"]],
  [6930, "Anas platyrhynchos", "Mallard", "species", 10, [48460, 1, 3, 6930], ["MALL"]],
] );

describe( "loadBirdCodes", ( ) => {
  it( "adds codes to cached taxa without overwriting them, and creates the rest", ( ) => {
    safeRealmWrite( global.realm, ( ) => {
      global.realm.create( "Taxon", {
        id: 6930, name: "Anas platyrhynchos", preferred_common_name: "Canard colvert",
      }, "modified" );
    }, "test setup" );

    loadBirdCodes( global.realm );

    const mallard = global.realm.objectForPrimaryKey( "Taxon", 6930 );
    expect( Array.from( mallard.birdCodes ) ).toEqual( ["MALL"] );
    expect( mallard.preferred_common_name ).toBe( "Canard colvert" );
    const goose = global.realm.objectForPrimaryKey( "Taxon", 7089 );
    expect( goose.preferred_common_name ).toBe( "Canada Goose" );
    expect( Array.from( goose.birdCodes ) ).toEqual( ["CANG"] );
    expect( goose._searchableName ).toContain( "CANG" );
  } );
} );
