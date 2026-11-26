const makePosition = ( accuracy, latitude ) => ( {
  coords: {
    latitude,
    longitude: latitude,
    accuracy,
    altitude: null,
    altitudeAccuracy: null,
  },
  timestamp: Date.now( ),
} );

// The module keeps the single app-wide watch and the best fix in module state,
// so each test needs a fresh copy of it, along with the fresh Geolocation mock
// that copy talks to
let Geolocation;
const loadWatcher = ( ) => {
  let watcher;
  jest.isolateModules( ( ) => {
    /* eslint-disable global-require */
    watcher = require( "sharedHelpers/accuratePositionWatcher" );
    Geolocation = require( "@react-native-community/geolocation" ).default;
    /* eslint-enable global-require */
  } );
  return watcher;
};

// Hands back a function that feeds positions to whatever watch is running
const mockWatch = ( ) => {
  let success = null;
  let failure = null;
  Geolocation.watchPosition.mockImplementation( ( onSuccess, onError ) => {
    success = onSuccess;
    failure = onError;
    return 1;
  } );
  return {
    emit: position => success( position ),
    fail: error => failure( error ),
  };
};

// infoWithExtra lands on console.info in tests (see tests/jest.setup.js)
const positionFixLogs = infoSpy => infoSpy.mock.calls
  .filter( call => call[0] === "position fix" )
  .map( call => call[1] );

describe( "fix logging", ( ) => {
  it( "logs the accuracy of every fix, including after one is accurate", ( ) => {
    const infoSpy = jest.spyOn( console, "info" ).mockImplementation( ( ) => {} );
    const { subscribeToPosition } = loadWatcher( );
    const watch = mockWatch( );
    subscribeToPosition( { onLocation: jest.fn( ) } );

    watch.emit( makePosition( 65, 1 ) );
    watch.emit( makePosition( 6, 2 ) );
    watch.emit( makePosition( 40, 3 ) );

    expect( positionFixLogs( infoSpy ).map( extra => extra.accuracy ) )
      .toEqual( [65, 6, 40] );
    infoSpy.mockRestore( );
  } );

  it( "records why a fix wasn't used", ( ) => {
    const infoSpy = jest.spyOn( console, "info" ).mockImplementation( ( ) => {} );
    const { subscribeToPosition } = loadWatcher( );
    const watch = mockWatch( );
    subscribeToPosition( { onLocation: jest.fn( ) } );

    watch.emit( makePosition( 20, 1 ) );
    watch.emit( makePosition( -1, 2 ) );
    watch.emit( makePosition( 50, 3 ) );

    expect( positionFixLogs( infoSpy ).map( extra => extra.outcome ) )
      .toEqual( ["used", "invalid", "worse"] );
    infoSpy.mockRestore( );
  } );
} );

describe( "subscribeToPosition", ( ) => {
  it( "runs a single watch no matter how many listeners there are", ( ) => {
    const { subscribeToPosition } = loadWatcher( );
    mockWatch( );

    const unsubscribeFirst = subscribeToPosition( { onLocation: jest.fn( ) } );
    const unsubscribeSecond = subscribeToPosition( { onLocation: jest.fn( ) } );

    expect( Geolocation.watchPosition ).toHaveBeenCalledTimes( 1 );

    unsubscribeFirst( );
    expect( Geolocation.clearWatch ).not.toHaveBeenCalled( );
    unsubscribeSecond( );
    expect( Geolocation.clearWatch ).toHaveBeenCalledTimes( 1 );
  } );

  it( "keeps the most accurate fix instead of the most recent one", ( ) => {
    const { subscribeToPosition } = loadWatcher( );
    const watch = mockWatch( );
    const onLocation = jest.fn( );
    subscribeToPosition( { onLocation } );

    watch.emit( makePosition( 30, 1 ) );
    watch.emit( makePosition( 12, 2 ) );
    watch.emit( makePosition( 40, 3 ) );

    expect( onLocation ).toHaveBeenCalledTimes( 2 );
    expect( onLocation ).toHaveBeenLastCalledWith(
      expect.objectContaining( { latitude: 2, positional_accuracy: 12 } ),
    );
  } );

  it( "ignores fixes the OS couldn't actually determine", ( ) => {
    const { subscribeToPosition } = loadWatcher( );
    const watch = mockWatch( );
    const onLocation = jest.fn( );
    subscribeToPosition( { onLocation } );

    watch.emit( makePosition( -1, 1 ) );

    expect( onLocation ).not.toHaveBeenCalled( );
  } );

  it( "ignores fixes that are too old to describe where the user is now", ( ) => {
    const { subscribeToPosition } = loadWatcher( );
    const watch = mockWatch( );
    const onLocation = jest.fn( );
    subscribeToPosition( { onLocation } );

    watch.emit( {
      ...makePosition( 5, 1 ),
      timestamp: Date.now( ) - ( 5 * 60 * 1000 ),
    } );

    expect( onLocation ).not.toHaveBeenCalled( );
  } );
} );

describe( "waitForAccuratePosition", ( ) => {
  it( "waits past the first coarse fix for one that's accurate enough", async ( ) => {
    const { waitForAccuratePosition } = loadWatcher( );
    const watch = mockWatch( );

    const pending = waitForAccuratePosition( );
    watch.emit( makePosition( 65, 1 ) );
    watch.emit( makePosition( 6, 2 ) );

    await expect( pending ).resolves.toEqual(
      expect.objectContaining( { latitude: 2, positional_accuracy: 6 } ),
    );
    expect( Geolocation.clearWatch ).toHaveBeenCalledTimes( 1 );
  } );

  it( "settles for the best fix it saw when it runs out of time", async ( ) => {
    jest.useFakeTimers( );
    const { waitForAccuratePosition } = loadWatcher( );
    const watch = mockWatch( );

    const pending = waitForAccuratePosition( );
    watch.emit( makePosition( 65, 1 ) );
    watch.emit( makePosition( 22, 2 ) );
    jest.runOnlyPendingTimers( );

    await expect( pending ).resolves.toEqual(
      expect.objectContaining( { latitude: 2, positional_accuracy: 22 } ),
    );
    jest.useRealTimers( );
  } );

  it( "reuses an accurate fix a warmed up watch already has", async ( ) => {
    const { startPositionWarmup, waitForAccuratePosition } = loadWatcher( );
    const watch = mockWatch( );

    startPositionWarmup( );
    watch.emit( makePosition( 5, 1 ) );
    Geolocation.watchPosition.mockClear( );

    await expect( waitForAccuratePosition( ) ).resolves.toEqual(
      expect.objectContaining( { latitude: 1, positional_accuracy: 5 } ),
    );
    expect( Geolocation.watchPosition ).not.toHaveBeenCalled( );
  } );

  it( "gives up when the watch errors so the caller can fall back", async ( ) => {
    const { waitForAccuratePosition } = loadWatcher( );
    const watch = mockWatch( );

    const pending = waitForAccuratePosition( );
    watch.fail( { code: 1, message: "denied" } );

    await expect( pending ).resolves.toBeNull( );
  } );
} );
