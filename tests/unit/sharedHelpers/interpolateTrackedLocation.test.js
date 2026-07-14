import {
  findInterpolatedLocation,
  MAX_INTERPOLATION_SPAN_MS,
  MAX_MATCH_GAP_MS,
  MAX_USABLE_ACCURACY_M,
} from "sharedHelpers/interpolateTrackedLocation";

const point = ( recordedAtMs, latitude, longitude, accuracy ) => ( {
  latitude,
  longitude,
  accuracy,
  recordedAt: new Date( recordedAtMs ),
} );

describe( "findInterpolatedLocation", ( ) => {
  it( "returns null when there are no points", ( ) => {
    expect( findInterpolatedLocation( [], 1000 ) ).toBeNull( );
  } );

  it( "linearly interpolates between the bracketing points", ( ) => {
    const points = [
      point( 0, 0, 0, 5 ),
      point( 100, 10, 20, 5 ),
    ];
    const result = findInterpolatedLocation( points, 50 );
    expect( result.latitude ).toBeCloseTo( 5 );
    expect( result.longitude ).toBeCloseTo( 10 );
  } );

  it( "filters out low-accuracy fixes so they don't corrupt interpolation", ( ) => {
    // A wildly inaccurate outlier sits exactly at the target time, but two
    // accurate fixes bracket it. The outlier should be ignored.
    const points = [
      point( 0, 0, 0, 5 ),
      point( 50, 999, 999, MAX_USABLE_ACCURACY_M + 500 ),
      point( 100, 10, 20, 5 ),
    ];
    const result = findInterpolatedLocation( points, 50 );
    // Interpolated from the two accurate points, not the outlier at (999,999)
    expect( result.latitude ).toBeCloseTo( 5 );
    expect( result.longitude ).toBeCloseTo( 10 );
  } );

  it( "falls back to all points when none meet the accuracy bar", ( ) => {
    const points = [
      point( 0, 1, 2, MAX_USABLE_ACCURACY_M + 100 ),
    ];
    const result = findInterpolatedLocation( points, 0 );
    expect( result.latitude ).toEqual( 1 );
    expect( result.longitude ).toEqual( 2 );
  } );

  it( "returns null when the closest point is beyond the max match gap", ( ) => {
    const points = [point( 0, 1, 2, 5 )];
    expect( findInterpolatedLocation( points, MAX_MATCH_GAP_MS + 1 ) ).toBeNull( );
  } );

  it( "snaps to the nearest fix instead of interpolating across a long gap", ( ) => {
    // Two accurate fixes far apart in time bracket the target. A straight-line
    // midpoint would be off the real route, so we snap to the temporally
    // nearest fix rather than interpolating.
    const span = MAX_INTERPOLATION_SPAN_MS + 60 * 1000;
    const points = [
      point( 0, 0, 0, 5 ),
      point( span, 10, 20, 5 ),
    ];
    // Target is nearer the first fix
    const nearPrev = findInterpolatedLocation( points, 60 * 1000 );
    expect( nearPrev.latitude ).toEqual( 0 );
    expect( nearPrev.longitude ).toEqual( 0 );
    // Target is nearer the second fix
    const nearNext = findInterpolatedLocation( points, span - 60 * 1000 );
    expect( nearNext.latitude ).toEqual( 10 );
    expect( nearNext.longitude ).toEqual( 20 );
  } );

  it( "still interpolates when the bracketing fixes are close in time", ( ) => {
    const span = MAX_INTERPOLATION_SPAN_MS - 1000;
    const points = [
      point( 0, 0, 0, 5 ),
      point( span, 10, 20, 5 ),
    ];
    const result = findInterpolatedLocation( points, span / 2 );
    expect( result.latitude ).toBeCloseTo( 5 );
    expect( result.longitude ).toBeCloseTo( 10 );
  } );
} );
