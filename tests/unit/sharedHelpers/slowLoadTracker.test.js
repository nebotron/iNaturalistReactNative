import {
  startSlowLoadMonitoring,
  stopSlowLoadMonitoring,
} from "sharedHelpers/slowLoadTracker";

const mockInfoWithExtra = jest.fn( );

jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: { extend: ( ) => ( { infoWithExtra: ( ...args ) => mockInfoWithExtra( ...args ) } ) },
} ) );

jest.mock( "navigation/navigationUtils", ( ) => ( {
  getCurrentRoute: ( ) => ( { name: "Suggestions" } ),
} ) );

const makeQuery = ( queryKey, hash ) => ( {
  queryKey,
  queryHash: hash || JSON.stringify( queryKey ),
  getObserversCount: ( ) => 1,
} );

// Drives the tracker the way the query cache would.
let emit;

const startWithFakeCache = ( ) => {
  startSlowLoadMonitoring( {
    getQueryCache: ( ) => ( {
      subscribe: listener => {
        emit = listener;
        return ( ) => { emit = null; };
      },
    } ),
  } );
};

describe( "slowLoadTracker", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    jest.useFakeTimers( );
    jest.spyOn( Date, "now" ).mockReturnValue( 1_000 );
    startWithFakeCache( );
  } );

  afterEach( ( ) => {
    stopSlowLoadMonitoring( );
    Date.now.mockRestore( );
    jest.useRealTimers( );
  } );

  it( "logs a fetch the user waited on", ( ) => {
    const query = makeQuery( ["scoreImage", "file:///photo.jpg"] );
    emit( { type: "updated", query, action: { type: "fetch" } } );
    Date.now.mockReturnValue( 9_000 );
    emit( { type: "updated", query, action: { type: "success" } } );

    expect( mockInfoWithExtra ).toHaveBeenCalledWith( "slow_query", expect.objectContaining( {
      query: "scoreImage",
      elapsedMs: 8_000,
      status: "success",
      screen: "Suggestions",
    } ) );
  } );

  it( "ignores a fetch fast enough not to notice", ( ) => {
    const query = makeQuery( ["scoreImage"] );
    emit( { type: "updated", query, action: { type: "fetch" } } );
    Date.now.mockReturnValue( 2_000 );
    emit( { type: "updated", query, action: { type: "success" } } );

    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "reports a fetch that hasn't come back rather than waiting for it", ( ) => {
    const query = makeQuery( ["scoreImage"] );
    emit( { type: "updated", query, action: { type: "fetch" } } );

    Date.now.mockReturnValue( 30_000 );
    jest.advanceTimersByTime( 30_000 );

    expect( mockInfoWithExtra ).toHaveBeenCalledWith( "query_hang", expect.objectContaining( {
      query: "scoreImage",
      elapsedMs: 29_000,
    } ) );

    // ...and doesn't log it again when it finally resolves
    mockInfoWithExtra.mockClear( );
    emit( { type: "updated", query, action: { type: "success" } } );
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "does not blame the app for time spent waiting on the network", ( ) => {
    const query = makeQuery( ["scoreImage"] );
    emit( { type: "updated", query, action: { type: "fetch" } } );
    emit( { type: "updated", query, action: { type: "pause" } } );
    Date.now.mockReturnValue( 60_000 );
    emit( { type: "updated", query, action: { type: "success" } } );

    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );

  it( "ignores fetches nothing on screen is waiting for", ( ) => {
    const query = { ...makeQuery( ["scoreImage"] ), getObserversCount: ( ) => 0 };
    emit( { type: "updated", query, action: { type: "fetch" } } );
    Date.now.mockReturnValue( 9_000 );
    emit( { type: "updated", query, action: { type: "success" } } );

    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
  } );
} );
