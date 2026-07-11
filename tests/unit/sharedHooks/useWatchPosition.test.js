import Geolocation from "@react-native-community/geolocation";
import { renderHook, waitFor } from "@testing-library/react-native";
import { useWatchPosition } from "sharedHooks";

const mockPositions = [
  {
    coords: {
      latitude: 1,
      longitude: 1,
      accuracy: 100,
    },
  },
  {
    coords: {
      latitude: 2,
      longitude: 2,
      accuracy: 20,
    },
  },
  {
    coords: {
      latitude: 3,
      longitude: 3,
      accuracy: 8,
    },
  },
];

const mockWatchPositionSuccess = jest.fn( onSuccess => onSuccess( ) );

describe( "useWatchPosition with inaccurate location", ( ) => {
  beforeEach( ( ) => {
    Geolocation.watchPosition.mockReset( );
    Geolocation.watchPosition.mockImplementation( success => {
      setTimeout( ( ) => mockWatchPositionSuccess( ( ) => success( mockPositions[0] ) ), 100 );
      return 0;
    } );
  } );

  // The success callback should have been called and that roughly
  // marks the end of async effects, so hopefull this prevents "outside of
  // act" warnings
  afterEach( ( ) => waitFor( ( ) => {
    expect( mockWatchPositionSuccess ).toHaveBeenCalled( );
    mockWatchPositionSuccess.mockClear( );
  } ) );

  it( "should be loading by default", async ( ) => {
    const { result } = renderHook( ( ) => useWatchPosition( { shouldFetchLocation: true } ) );
    await waitFor( ( ) => {
      expect( result.current.isFetchingLocation ).toBeTruthy( );
    } );
  } );

  it( "should return a user location", async ( ) => {
    const { result } = renderHook( ( ) => useWatchPosition( { shouldFetchLocation: true } ) );
    await waitFor( ( ) => {
      expect( result.current.userLocation.latitude ).toBeDefined( );
    } );
    expect( result.current.userLocation.latitude ).toEqual( mockPositions[0].coords.latitude );
  } );
} );

describe( "useWatchPosition with accurate location", ( ) => {
  beforeEach( ( ) => {
    Geolocation.watchPosition.mockImplementation( success => {
      setTimeout( ( ) => {
        mockWatchPositionSuccess( ( ) => success( mockPositions[0] ) );
        setTimeout( ( ) => {
          mockWatchPositionSuccess( ( ) => success( mockPositions[1] ) );
          setTimeout( ( ) => {
            mockWatchPositionSuccess( ( ) => success( mockPositions[2] ) );
          }, 100 );
        }, 100 );
      }, 100 );
      return 0;
    } );
  } );

  it( "should stop watching position when target accuracy reached", async ( ) => {
    const { result } = renderHook( ( ) => useWatchPosition( { shouldFetchLocation: true } ) );
    await waitFor( ( ) => {
      expect( result.current.userLocation?.positional_accuracy )
        .toEqual( mockPositions[2].coords.accuracy );
    } );
    expect( Geolocation.clearWatch ).toHaveBeenCalledTimes( 1 );
  } );
} );

describe( "useWatchPosition with fluctuating accuracy", ( ) => {
  // Fixes that never reach the target accuracy, delivered best-in-the-middle
  // so the final reading is worse than one we already saw
  const fluctuatingPositions = [
    { coords: { latitude: 1, longitude: 1, accuracy: 40 } },
    { coords: { latitude: 2, longitude: 2, accuracy: 15 } },
    { coords: { latitude: 3, longitude: 3, accuracy: 60 } },
  ];

  beforeEach( ( ) => {
    mockWatchPositionSuccess.mockClear( );
    Geolocation.watchPosition.mockReset( );
    Geolocation.watchPosition.mockImplementation( success => {
      setTimeout( ( ) => {
        mockWatchPositionSuccess( ( ) => success( fluctuatingPositions[0] ) );
        setTimeout( ( ) => {
          mockWatchPositionSuccess( ( ) => success( fluctuatingPositions[1] ) );
          setTimeout( ( ) => {
            mockWatchPositionSuccess( ( ) => success( fluctuatingPositions[2] ) );
          }, 100 );
        }, 100 );
      }, 100 );
      return 0;
    } );
  } );

  it( "should keep the most accurate fix, not the latest one", async ( ) => {
    const { result } = renderHook( ( ) => useWatchPosition( { shouldFetchLocation: true } ) );
    // Wait until the final (worse) fix has been delivered
    await waitFor( ( ) => {
      expect( mockWatchPositionSuccess ).toHaveBeenCalledTimes( 3 );
    } );
    // The retained location should be the best fix (15), not the latest (60)
    expect( result.current.userLocation.positional_accuracy )
      .toEqual( fluctuatingPositions[1].coords.accuracy );
  } );
} );

describe( "useWatchPosition when shouldn't fetch", ( ) => {
  beforeEach( ( ) => {
    Geolocation.watchPosition.mockReset( );
  } );

  it( "should not watch position when shouldFetchLocation is false", async ( ) => {
    renderHook( ( ) => useWatchPosition( { shouldFetchLocation: false } ) );
    await waitFor( ( ) => {
      expect( Geolocation.watchPosition ).not.toHaveBeenCalled( );
    } );
  } );
} );
