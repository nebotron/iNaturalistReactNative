import {
  accuracyToEncompassBounds,
  boundingBoxGeojsonToBounds,
  DEFAULT_OBSERVATION_LOCATION_ACCURACY_METERS,
  getObservationCoordinates,
  hasValidMapCoordinates,
  haversineMeters,
  regionForAccuracy,
  regionForObservationLocation,
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
