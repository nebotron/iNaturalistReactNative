import {
  DEFAULT_NEARBY_RADIUS_KM,
  MAX_NEARBY_RADIUS_KM,
  MIN_NEARBY_RADIUS_KM,
  parseNearbyRadiusKm,
} from "sharedHelpers/nearbyRadius";

describe( "parseNearbyRadiusKm", ( ) => {
  it( "returns the default for empty input", ( ) => {
    expect( parseNearbyRadiusKm( "" ) ).toBe( DEFAULT_NEARBY_RADIUS_KM );
  } );

  it( "clamps values to the allowed range", ( ) => {
    expect( parseNearbyRadiusKm( "0" ) ).toBe( MIN_NEARBY_RADIUS_KM );
    expect( parseNearbyRadiusKm( "50000" ) ).toBe( MAX_NEARBY_RADIUS_KM );
    expect( parseNearbyRadiusKm( "25" ) ).toBe( 25 );
    expect( parseNearbyRadiusKm( "40000" ) ).toBe( 40000 );
  } );
} );
