import {
  accuracyToEncompassBounds,
  boundingBoxGeojsonToBounds,
  DEFAULT_OBSERVATION_LOCATION_ACCURACY_METERS,
  getMapRegion,
  getObservationCoordinates,
  hasValidMapCoordinates,
  haversineMeters,
  regionForAccuracy,
  regionForObservationLocation,
  regionFromBounds,
} from "components/SharedComponents/Map/helpers/mapHelpers";

describe( "mapHelpers place accuracy", ( ) => {
  const seattleBounds = {
    swlat: 47.349,
    swlng: -122.442,
    nelat: 47.778,
    nelng: -122.067,
  };

  const seattleCenter = {
    latitude: 47.6062,
    longitude: -122.3321,
  };

  const seattleBoundingBox = {
    coordinates: [[
      [-122.442, 47.349],
      [-122.067, 47.349],
      [-122.067, 47.778],
      [-122.442, 47.778],
      [-122.442, 47.349],
    ]],
  };

  test( "boundingBoxGeojsonToBounds should parse place bounding boxes", ( ) => {
    expect( boundingBoxGeojsonToBounds( seattleBoundingBox ) ).toEqual( seattleBounds );
  } );

  test( "accuracyToEncompassBounds should use the farthest bbox corner", ( ) => {
    const accuracy = accuracyToEncompassBounds(
      seattleCenter.latitude,
      seattleCenter.longitude,
      seattleBounds,
    );

    const cornerDistances = [
      haversineMeters(
        seattleCenter.latitude,
        seattleCenter.longitude,
        seattleBounds.swlat,
        seattleBounds.swlng,
      ),
      haversineMeters(
        seattleCenter.latitude,
        seattleCenter.longitude,
        seattleBounds.swlat,
        seattleBounds.nelng,
      ),
      haversineMeters(
        seattleCenter.latitude,
        seattleCenter.longitude,
        seattleBounds.nelat,
        seattleBounds.swlng,
      ),
      haversineMeters(
        seattleCenter.latitude,
        seattleCenter.longitude,
        seattleBounds.nelat,
        seattleBounds.nelng,
      ),
    ];

    expect( accuracy ).toBe( Math.max( ...cornerDistances ) );
  } );

  test( "regionForAccuracy should invert crosshair accuracy math", ( ) => {
    const radiusToMapHeight = 127 / 800;
    const mapDimensionsRatio = 1.2;
    const accuracyMeters = 5000;
    const region = regionForAccuracy(
      seattleCenter.latitude,
      seattleCenter.longitude,
      accuracyMeters,
      radiusToMapHeight,
      mapDimensionsRatio,
    );

    expect( region.latitude ).toBe( seattleCenter.latitude );
    expect( region.longitude ).toBe( seattleCenter.longitude );
    expect( region.longitudeDelta ).toBeCloseTo(
      region.latitudeDelta * mapDimensionsRatio,
    );
  } );
} );

describe( "mapHelpers observation location", ( ) => {
  const seattleCenter = {
    latitude: 47.6062,
    longitude: -122.3321,
  };

  const radiusToMapHeight = 127 / 800;
  const mapDimensionsRatio = 1.2;

  test( "hasValidMapCoordinates should reject null island and invalid values", ( ) => {
    expect( hasValidMapCoordinates( 0, 0 ) ).toBe( false );
    expect( hasValidMapCoordinates( null, null ) ).toBe( false );
    expect(
      hasValidMapCoordinates( seattleCenter.latitude, seattleCenter.longitude ),
    ).toBe( true );
  } );

  test( "getObservationCoordinates should prefer private coordinates", ( ) => {
    expect( getObservationCoordinates( {
      latitude: 1,
      longitude: 2,
      privateLatitude: seattleCenter.latitude,
      privateLongitude: seattleCenter.longitude,
    } ) ).toEqual( seattleCenter );
  } );

  test( "regionForObservationLocation should return null without map dimensions", ( ) => {
    expect( regionForObservationLocation(
      { latitude: seattleCenter.latitude, longitude: seattleCenter.longitude },
      undefined,
      mapDimensionsRatio,
    ) ).toBeNull( );
  } );

  test( "regionForObservationLocation should use a default accuracy when missing", ( ) => {
    const region = regionForObservationLocation(
      { latitude: seattleCenter.latitude, longitude: seattleCenter.longitude },
      radiusToMapHeight,
      mapDimensionsRatio,
    );
    const expectedRegion = regionForAccuracy(
      seattleCenter.latitude,
      seattleCenter.longitude,
      DEFAULT_OBSERVATION_LOCATION_ACCURACY_METERS,
      radiusToMapHeight,
      mapDimensionsRatio,
    );

    expect( region ).toEqual( expectedRegion );
  } );
} );

describe( "regionFromBounds", ( ) => {
  it( "covers exactly the bounds it was given", ( ) => {
    const region = regionFromBounds( {
      swlat: 10, swlng: 20, nelat: 30, nelng: 40,
    } );

    expect( region.latitude ).toBe( 20 );
    expect( region.longitude ).toBe( 30 );
    expect( region.latitudeDelta ).toBe( 20 );
    expect( region.longitudeDelta ).toBe( 20 );
  } );

  it( "round trips the bounds of a viewport without growing it", ( ) => {
    const bounds = {
      swlat: 37.7, swlng: -122.5, nelat: 37.8, nelng: -122.4,
    };
    const region = regionFromBounds( bounds );

    expect( region.latitude - ( region.latitudeDelta / 2 ) ).toBeCloseTo( bounds.swlat );
    expect( region.longitude - ( region.longitudeDelta / 2 ) ).toBeCloseTo( bounds.swlng );
    expect( region.latitude + ( region.latitudeDelta / 2 ) ).toBeCloseTo( bounds.nelat );
    expect( region.longitude + ( region.longitudeDelta / 2 ) ).toBeCloseTo( bounds.nelng );
  } );

  it( "keeps deltas positive when the bounds are inverted", ( ) => {
    const region = regionFromBounds( {
      swlat: 30, swlng: 40, nelat: 10, nelng: 20,
    } );

    expect( region.latitudeDelta ).toBe( 20 );
    expect( region.longitudeDelta ).toBe( 20 );
  } );
} );

describe( "getMapRegion", ( ) => {
  it( "frames the bounds with a bit of padding so the full range is visible", ( ) => {
    const region = getMapRegion( {
      swlat: 10, swlng: 20, nelat: 30, nelng: 40,
    } );

    expect( region.latitude ).toBe( 20 );
    expect( region.longitude ).toBe( 30 );
    expect( region.latitudeDelta ).toBe( 28 );
    expect( region.longitudeDelta ).toBe( 28 );
  } );

  it( "centers on the point when the bounds are a single point", ( ) => {
    const region = getMapRegion( {
      swlat: 37.5, swlng: -122.1, nelat: 37.5, nelng: -122.1,
    } );

    expect( region.latitude ).toBe( 37.5 );
    expect( region.longitude ).toBe( -122.1 );
    expect( region.latitudeDelta ).toBe( 0 );
    expect( region.longitudeDelta ).toBe( 0 );
  } );

  it( "pads the dimension that has range when the bounding box is flat", ( ) => {
    const region = getMapRegion( {
      swlat: 37.5, swlng: -122.5, nelat: 37.5, nelng: -120.5,
    } );

    expect( region.latitude ).toBe( 37.5 );
    expect( region.longitude ).toBe( -121.5 );
    expect( region.latitudeDelta ).toBe( 0 );
    expect( region.longitudeDelta ).toBeCloseTo( 2.8 );
  } );

  it( "does not ask for impossible deltas when the bounds are worldwide", ( ) => {
    const region = getMapRegion( {
      swlat: -90, swlng: -180, nelat: 90, nelng: 180,
    } );

    expect( region.latitude ).toBe( 0 );
    expect( region.longitude ).toBe( 0 );
    expect( region.latitudeDelta ).toBe( 89 );
    expect( region.longitudeDelta ).toBe( 179 );
  } );

  it( "keeps deltas positive when the bounds are inverted", ( ) => {
    const region = getMapRegion( {
      swlat: 30, swlng: 40, nelat: 10, nelng: 20,
    } );

    expect( region.latitudeDelta ).toBe( 28 );
    expect( region.longitudeDelta ).toBe( 28 );
  } );
} );
