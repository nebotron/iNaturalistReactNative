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

    // Held back briefly in case it's the first of a burst.
    expect( mockInfoWithExtra ).not.toHaveBeenCalled( );
    jest.advanceTimersByTime( 5_000 );

    expect( mockInfoWithExtra ).toHaveBeenCalledWith( "slow_query", expect.objectContaining( {
      query: "scoreImage",
      elapsedMs: 8_000,
      status: "success",
      screen: "Suggestions",
    } ) );
  } );

  it( "reports several slow fetches at once as one burst", ( ) => {
    ["searchObservations", "notificationsCount", "searchAnnouncements"].forEach( name => {
      const query = makeQuery( [name] );
      Date.now.mockReturnValue( 1_000 );
      emit( { type: "updated", query, action: { type: "fetch" } } );
    } );
    Date.now.mockReturnValue( 12_000 );
    ["searchObservations", "notificationsCount"].forEach( name => {
      emit( { type: "updated", query: makeQuery( [name] ), action: { type: "success" } } );
    } );
    Date.now.mockReturnValue( 14_000 );
    emit( {
      type: "updated",
      query: makeQuery( ["searchAnnouncements"] ),
      action: { type: "error" },
    } );
    jest.advanceTimersByTime( 5_000 );

    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 1 );
    expect( mockInfoWithExtra ).toHaveBeenCalledWith( "slow_query_burst", {
      count: 3,
      hangs: 0,
      errors: 1,
      medianMs: 11_000,
      maxMs: 13_000,
      queries: "searchObservations,notificationsCount,searchAnnouncements",
      screens: "Suggestions",
    } );
  } );

  it( "starts a new burst window after the last one flushed", ( ) => {
    const slowFetch = name => {
      Date.now.mockReturnValue( 1_000 );
      emit( { type: "updated", query: makeQuery( [name] ), action: { type: "fetch" } } );
      Date.now.mockReturnValue( 9_000 );
      emit( { type: "updated", query: makeQuery( [name] ), action: { type: "success" } } );
    };

    slowFetch( "searchObservations" );
    jest.advanceTimersByTime( 5_000 );
    slowFetch( "searchAnnouncements" );
    jest.advanceTimersByTime( 5_000 );

    expect( mockInfoWithExtra ).toHaveBeenCalledTimes( 2 );
    expect( mockInfoWithExtra.mock.calls.map( call => call[0] ) )
      .toEqual( ["slow_query", "slow_query"] );
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
