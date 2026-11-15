import {
  cachedRequest,
  REQUEST_CACHE_TTL_MS,
} from "components/WildlifeHotspots/requestCache";

describe( "cachedRequest", ( ) => {
  afterEach( ( ) => {
    jest.useRealTimers( );
  } );

  it( "answers the same request from storage until it's a day old", async ( ) => {
    jest.useFakeTimers( { now: 1_000_000 } );
    const fetcher = jest.fn( ( ) => Promise.resolve( { value: 1 } ) );
    await cachedRequest( "test-ttl", 10, { q: "a" }, fetcher );
    jest.setSystemTime( 1_000_000 + REQUEST_CACHE_TTL_MS - 1 );
    expect( await cachedRequest( "test-ttl", 10, { q: "a" }, fetcher ) ).toEqual( { value: 1 } );
    expect( fetcher ).toHaveBeenCalledTimes( 1 );
    jest.setSystemTime( 1_000_000 + REQUEST_CACHE_TTL_MS );
    await cachedRequest( "test-ttl", 10, { q: "a" }, fetcher );
    expect( fetcher ).toHaveBeenCalledTimes( 2 );
  } );

  it( "sends a request made twice at once only once", async ( ) => {
    const fetcher = jest.fn( ( ) => Promise.resolve( 1 ) );
    await Promise.all( [
      cachedRequest( "test-dedupe", 10, "a", fetcher ),
      cachedRequest( "test-dedupe", 10, "a", fetcher ),
    ] );
    expect( fetcher ).toHaveBeenCalledTimes( 1 );
  } );

  it( "doesn't store failures or rejected results", async ( ) => {
    const failing = jest.fn( ( ) => Promise.reject( new Error( "offline" ) ) );
    await expect( cachedRequest( "test-fail", 10, "a", failing ) ).rejects.toThrow( "offline" );
    await expect( cachedRequest( "test-fail", 10, "a", failing ) ).rejects.toThrow( "offline" );
    expect( failing ).toHaveBeenCalledTimes( 2 );

    const empty = jest.fn( ( ) => Promise.resolve( [] as number[] ) );
    const nonEmpty = ( r: number[] ) => r.length > 0;
    await cachedRequest( "test-fail", 10, "b", empty, nonEmpty );
    await cachedRequest( "test-fail", 10, "b", empty, nonEmpty );
    expect( empty ).toHaveBeenCalledTimes( 2 );
  } );

  it( "keeps only the newest entries of a namespace", async ( ) => {
    jest.useFakeTimers( { now: 5_000_000 } );
    const fetcher = jest.fn( ( ) => Promise.resolve( 1 ) );
    for ( const key of ["a", "b", "c"] ) {
      jest.advanceTimersByTime( 1000 );
      // eslint-disable-next-line no-await-in-loop
      await cachedRequest( "test-limit", 2, key, fetcher );
    }
    expect( fetcher ).toHaveBeenCalledTimes( 3 );
    await cachedRequest( "test-limit", 2, "c", fetcher );
    await cachedRequest( "test-limit", 2, "b", fetcher );
    expect( fetcher ).toHaveBeenCalledTimes( 3 );
    await cachedRequest( "test-limit", 2, "a", fetcher );
    expect( fetcher ).toHaveBeenCalledTimes( 4 );
  } );
} );
