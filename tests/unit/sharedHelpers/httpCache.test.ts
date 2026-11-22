import { MMKV } from "react-native-mmkv";
import {
  CACHED_AT_HEADER,
  createHttpCache,
  HTTP_CACHE_TTL_MS,
  requesterOf,
} from "sharedHelpers/httpCache";

const URL = "https://api.inaturalist.org/v2/observations?taxon_id=1";

const jsonResponse = ( body: unknown, status = 200 ) => new Response( JSON.stringify( body ), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8" },
} );

const jwt = ( payload: object ) => {
  const encoded = Buffer.from( JSON.stringify( payload ) ).toString( "base64url" );
  return `header.${encoded}.signature`;
};

const memoryStore = ( ) => {
  const files = new Map<string, string>( );
  return {
    files,
    read: jest.fn( async ( file: string ) => {
      const body = files.get( file );
      if ( body === undefined ) throw new Error( "ENOENT" );
      return body;
    } ),
    write: jest.fn( async ( file: string, body: string ) => { files.set( file, body ); } ),
    remove: jest.fn( async ( file: string ) => { files.delete( file ); } ),
    clear: jest.fn( async ( ) => { files.clear( ); } ),
  };
};

// Reads a body the way inatjs does, through text( ), which is what saves it
const read = async ( response: Response ) => JSON.parse( await response.text( ) );

// Lets the save that follows reading a body finish
const settle = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

describe( "httpCache", ( ) => {
  let network: jest.Mock;
  let online: boolean;
  let store: ReturnType<typeof memoryStore>;
  let storage: MMKV;

  const makeCache = ( ) => createHttpCache( {
    fetch: network as unknown as typeof fetch,
    store,
    storage,
    isOnline: ( ) => online,
    indexWriteDelayMs: 0,
  } );

  beforeEach( ( ) => {
    network = jest.fn( );
    online = true;
    store = memoryStore( );
    storage = new MMKV( { id: "http-cache-test" } );
    storage.clearAll( );
  } );

  it( "serves a fetched response when the network fails", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
    const first = await cache.fetch( URL );
    expect( await read( first ) ).toEqual( { results: [1] } );
    await settle( );

    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    const second = await cache.fetch( URL );
    expect( await read( second ) ).toEqual( { results: [1] } );
    expect( second.headers.get( CACHED_AT_HEADER ) ).toBeTruthy( );
  } );

  it( "serves from the cache without asking the network while offline", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
    await ( await cache.fetch( URL ) ).text( );
    await settle( );

    online = false;
    const response = await cache.fetch( URL );
    expect( await read( response ) ).toEqual( { results: [1] } );
    expect( network ).toHaveBeenCalledTimes( 1 );
  } );

  it( "still goes to the network offline when nothing is cached", async ( ) => {
    const cache = makeCache( );
    online = false;
    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    await expect( cache.fetch( URL ) ).rejects.toThrow( "Network request failed" );
  } );

  it( "always fetches from the network while online", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { v: 1 } ) );
    await ( await cache.fetch( URL ) ).text( );
    await settle( );
    network.mockResolvedValueOnce( jsonResponse( { v: 2 } ) );
    expect( await read( await cache.fetch( URL ) ) ).toEqual( { v: 2 } );
    await settle( );

    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    expect( await read( await cache.fetch( URL ) ) ).toEqual( { v: 2 } );
  } );

  it( "survives a restart", async ( ) => {
    network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
    const before = makeCache( );
    await ( await before.fetch( URL ) ).text( );
    await settle( );
    before.flush( );

    const after = makeCache( );
    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    expect( await read( await after.fetch( URL ) ) ).toEqual( { results: [1] } );
  } );

  it( "doesn't cache errors, non-JSON, or writes", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { error: "nope" }, 500 ) );
    await ( await cache.fetch( URL ) ).text( );
    network.mockResolvedValueOnce( new Response( "png", {
      status: 200, headers: { "Content-Type": "image/png" },
    } ) );
    await ( await cache.fetch( "https://example.com/a.png" ) ).text( );
    network.mockResolvedValueOnce( jsonResponse( { id: 1 } ) );
    await ( await cache.fetch( URL, { method: "PUT", body: "{}" } ) ).text( );
    await settle( );
    expect( store.write ).not.toHaveBeenCalled( );
  } );

  it( "caches a long GET sent as a POST, keyed by its body", async ( ) => {
    const cache = makeCache( );
    const init = ( body: string ) => ( {
      method: "POST",
      body,
      headers: { "X-HTTP-Method-Override": "GET" },
    } );
    network.mockResolvedValueOnce( jsonResponse( { q: "a" } ) );
    await ( await cache.fetch( URL, init( "a" ) ) ).text( );
    await settle( );

    network.mockRejectedValue( new TypeError( "Network request failed" ) );
    expect( await read( await cache.fetch( URL, init( "a" ) ) ) ).toEqual( { q: "a" } );
    await expect( cache.fetch( URL, init( "b" ) ) ).rejects.toThrow( );
  } );

  it( "never writes responses that hand out tokens", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { api_token: "secret" } ) );
    await ( await cache.fetch( "https://www.inaturalist.org/users/api_token" ) ).text( );
    await settle( );
    expect( store.write ).not.toHaveBeenCalled( );
  } );

  it( "keeps each user's responses apart", async ( ) => {
    const cache = makeCache( );
    const as = ( userId: number ) => ( {
      headers: { Authorization: jwt( { user_id: userId } ) },
    } );
    network.mockResolvedValueOnce( jsonResponse( { user: 1 } ) );
    await ( await cache.fetch( URL, as( 1 ) ) ).text( );
    await settle( );

    network.mockRejectedValue( new TypeError( "Network request failed" ) );
    await expect( cache.fetch( URL, as( 2 ) ) ).rejects.toThrow( );
    expect( await read( await cache.fetch( URL, as( 1 ) ) ) ).toEqual( { user: 1 } );
  } );

  it( "drops entries past the TTL", async ( ) => {
    jest.useFakeTimers( { now: 0, doNotFake: ["setTimeout"] } );
    try {
      const cache = makeCache( );
      network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
      await ( await cache.fetch( URL ) ).text( );
      await settle( );
      jest.setSystemTime( HTTP_CACHE_TTL_MS + 1 );
      network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
      await expect( cache.fetch( URL ) ).rejects.toThrow( );
    } finally {
      jest.useRealTimers( );
    }
  } );

  it( "falls back to the network when a cached file is gone", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
    await ( await cache.fetch( URL ) ).text( );
    await settle( );
    store.files.clear( );
    online = false;
    network.mockResolvedValueOnce( jsonResponse( { results: [2] } ) );
    expect( await read( await cache.fetch( URL ) ) ).toEqual( { results: [2] } );
  } );

  it( "clears everything", async ( ) => {
    const cache = makeCache( );
    network.mockResolvedValueOnce( jsonResponse( { results: [1] } ) );
    await ( await cache.fetch( URL ) ).text( );
    await settle( );
    await cache.clear( );
    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    await expect( cache.fetch( URL ) ).rejects.toThrow( );
  } );

  describe( "requesterOf", ( ) => {
    it( "names the user or application without keeping the token", ( ) => {
      expect( requesterOf( undefined ) ).toBe( "none" );
      expect( requesterOf( jwt( { user_id: 42 } ) ) ).toBe( "user:42" );
      expect( requesterOf( jwt( { application: "ios" } ) ) ).toBe( "app:ios" );
      expect( requesterOf( "opaque-token" ) ).not.toContain( "opaque-token" );
    } );
  } );
} );
