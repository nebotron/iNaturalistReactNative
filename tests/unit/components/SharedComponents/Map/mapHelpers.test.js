import {
  accuracyToEncompassBounds,
  boundingBoxGeojsonToBounds,
  haversineMeters,
  regionForAccuracy,
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
