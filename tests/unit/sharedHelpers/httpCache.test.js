import {
  cacheKeyFor,
  clearHttpCache,
  createCachedFetch,
} from "sharedHelpers/httpCache";

const API = "https://api.inaturalist.org/v2/observations/abc";

// The wrapper writes to disk without blocking the response, so give that
// write a turn before asking what's cached.
const flush = ( ) => new Promise( resolve => {
  setImmediate( resolve );
} );

const jsonResponse = ( body, contentType = "application/json; charset=utf-8" ) => (
  new Response( JSON.stringify( body ), {
    status: 200,
    headers: { "Content-Type": contentType },
  } )
);

const offline = ( ) => Object.assign(
  new TypeError( "Network request failed" ),
  { name: "TypeError" },
);

describe( "cacheKeyFor", ( ) => {
  it( "keys a GET on its url", ( ) => {
    expect( cacheKeyFor( API ) ).toEqual( `GET ${API}` );
  } );

  it( "treats a method-override POST as the read it is, body and all", ( ) => {
    const key = cacheKeyFor( API, {
      method: "post",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: "{\"fields\":\"all\"}",
    } );

    expect( key ).toEqual( `GET ${API} {"fields":"all"}` );
  } );

  it( "reads the override header whatever its case", ( ) => {
    expect( cacheKeyFor( API, {
      method: "post",
      headers: { "x-http-method-override": "GET" },
    } ) ).toBeTruthy( );
  } );

  it( "refuses a real write", ( ) => {
    expect( cacheKeyFor( API, { method: "POST", body: "{}" } ) ).toBeNull( );
  } );

  it( "refuses anything to do with credentials", ( ) => {
    expect(
      cacheKeyFor( "https://www.inaturalist.org/users/api_token" ),
    ).toBeNull( );
    expect( cacheKeyFor( "https://www.inaturalist.org/oauth/token" ) ).toBeNull( );
  } );
} );

describe( "createCachedFetch", ( ) => {
  beforeEach( ( ) => {
    clearHttpCache( );
  } );

  it( "answers from the last response it saw when the network fails", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { results: ["cached"] } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API );
    await flush( );
    const response = await cachedFetch( API );

    expect( await response.json( ) ).toEqual( { results: ["cached"] } );
  } );

  it( "goes to the network, not the cache, whenever it can", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { results: ["old"] } ) )
      .mockResolvedValueOnce( jsonResponse( { results: ["fresh"] } ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API );
    await flush( );
    const response = await cachedFetch( API );

    expect( await response.json( ) ).toEqual( { results: ["fresh"] } );
    expect( baseFetch ).toHaveBeenCalledTimes( 2 );
  } );

  it( "caches the long reads iNaturalist's client sends as POSTs", async ( ) => {
    const init = {
      method: "post",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: "{\"fields\":\"everything\"}",
    };
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { results: ["detail"] } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API, init );
    await flush( );
    const response = await cachedFetch( API, init );

    expect( await response.json( ) ).toEqual( { results: ["detail"] } );
  } );

  it( "does not answer one request with another request's response", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { results: ["first"] } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API, {
      method: "post",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: "{\"uuid\":\"first\"}",
    } );
    await flush( );

    await expect( cachedFetch( API, {
      method: "post",
      headers: { "X-HTTP-Method-Override": "GET" },
      body: "{\"uuid\":\"second\"}",
    } ) ).rejects.toThrow( /Network request failed/ );
  } );

  it( "never replays a write", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { id: 1 } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API, { method: "POST", body: "{}" } );
    await flush( );

    await expect(
      cachedFetch( API, { method: "POST", body: "{}" } ),
    ).rejects.toThrow( /Network request failed/ );
  } );

  it( "leaves binary responses to the caches that understand them", async ( ) => {
    const tile = "https://tiles.inaturalist.org/1/2/3.png";
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( new Response( "PNGDATA", {
        status: 200,
        headers: { "Content-Type": "image/png" },
      } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( tile );
    await flush( );

    await expect( cachedFetch( tile ) ).rejects.toThrow( /Network request failed/ );
  } );

  it( "does not keep a failed response to hand back later", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( new Response( "{}", {
        status: 500,
        headers: { "Content-Type": "application/json" },
      } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API );
    await flush( );

    await expect( cachedFetch( API ) ).rejects.toThrow( /Network request failed/ );
  } );

  it( "raises the network error when it has nothing cached", async ( ) => {
    const baseFetch = jest.fn( ).mockRejectedValue( offline( ) );

    await expect( createCachedFetch( baseFetch )( API ) )
      .rejects.toThrow( /Network request failed/ );
  } );

  it( "forgets everything when cleared", async ( ) => {
    const baseFetch = jest.fn( )
      .mockResolvedValueOnce( jsonResponse( { results: ["cached"] } ) )
      .mockRejectedValueOnce( offline( ) );
    const cachedFetch = createCachedFetch( baseFetch );

    await cachedFetch( API );
    await flush( );
    clearHttpCache( );

    await expect( cachedFetch( API ) ).rejects.toThrow( /Network request failed/ );
  } );
} );
