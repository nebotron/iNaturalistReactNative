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

// The watcher keeps the app-wide watch in module state, so each test loads a
// fresh copy of it, the helper that shares it, and the wrapper they both call
let watcher;
let fetchAccurateUserLocation;
let wrapper;
let emit;
beforeEach( ( ) => {
  jest.isolateModules( ( ) => {
    /* eslint-disable global-require */
    wrapper = require( "sharedHelpers/geolocationWrapper" );
    watcher = require( "sharedHelpers/accuratePositionWatcher" );
    fetchAccurateUserLocation = require( "sharedHelpers/fetchAccurateUserLocation" ).default;
    /* eslint-enable global-require */
  } );
  jest.spyOn( wrapper, "watchPosition" ).mockImplementation( onSuccess => {
    emit = onSuccess;
    return 1;
  } );
  jest.spyOn( wrapper, "clearWatch" ).mockImplementation( ( ) => {} );
  jest.spyOn( wrapper, "checkLocationPermissions" ).mockResolvedValue( "granted" );
  jest.spyOn( wrapper, "getCurrentPositionWithOptions" )
    .mockResolvedValue( makePosition( 500, 9 ) );
} );

afterEach( ( ) => {
  jest.useRealTimers( );
  jest.restoreAllMocks( );
} );

describe( "fetchAccurateUserLocation", ( ) => {
  it( "checks permission when no watch is running", async ( ) => {
    jest.useFakeTimers( );
    const pending = fetchAccurateUserLocation( );
    await Promise.resolve( );
    jest.runAllTimers( );
    await pending;

    expect( wrapper.checkLocationPermissions ).toHaveBeenCalled( );
  } );

  it( "skips the permission check and one-shot request while a watch has a fix", async ( ) => {
    jest.useFakeTimers( );
    watcher.startPositionWarmup( );
    emit( makePosition( 50, 1 ) );

    const pending = fetchAccurateUserLocation( );
    jest.runAllTimers( );
    const location = await pending;

    expect( wrapper.checkLocationPermissions ).not.toHaveBeenCalled( );
    expect( wrapper.getCurrentPositionWithOptions ).not.toHaveBeenCalled( );
    expect( location?.positional_accuracy ).toEqual( 50 );
  } );

  it( "returns an accurate fix from a warmed up watch right away", async ( ) => {
    watcher.startPositionWarmup( );
    emit( makePosition( 5, 2 ) );

    const location = await fetchAccurateUserLocation( );

    expect( location?.latitude ).toEqual( 2 );
    expect( wrapper.checkLocationPermissions ).not.toHaveBeenCalled( );
  } );
} );
