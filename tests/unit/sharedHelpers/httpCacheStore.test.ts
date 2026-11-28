import { NativeModules } from "react-native";
import { MMKV } from "react-native-mmkv";
import type * as HttpCache from "sharedHelpers/httpCache";

const URL = "https://api.inaturalist.org/v2/observations?taxon_id=1";
const BODY = JSON.stringify( { results: [{ id: 1, name: "naïve café" }] } );

const jsonResponse = ( ) => new Response( BODY, {
  status: 200,
  headers: { "Content-Type": "application/json" },
} );

// Lets the save that follows reading a body finish
const settle = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

// httpCache reads NativeModules.TextFile when it loads, so load a fresh copy
// after setting it up, with a react-native-fs that keeps files in memory
const loadHttpCache = ( ) => {
  const files = new Map<string, string>( );
  const fs = {
    CachesDirectoryPath: "caches",
    mkdir: jest.fn( async ( ) => undefined ),
    unlink: jest.fn( async ( ) => undefined ),
    writeFile: jest.fn( async ( path: string, contents: string, _encoding: string ) => {
      files.set( path, contents );
    } ),
    readFile: jest.fn( async ( path: string, _encoding: string ) => files.get( path ) as string ),
  };
  let module: typeof HttpCache | undefined;
  jest.isolateModules( ( ) => {
    jest.doMock( "@dr.pogodin/react-native-fs", ( ) => fs );
    module = jest.requireActual<typeof HttpCache>( "sharedHelpers/httpCache" );
  } );
  return { module: module as typeof HttpCache, fs };
};

describe( "httpCache's file store", ( ) => {
  let network: jest.Mock;
  let storage: MMKV;

  beforeEach( ( ) => {
    network = jest.fn( );
    storage = new MMKV( { id: "http-cache-store-test" } );
    storage.clearAll( );
  } );

  afterEach( ( ) => {
    delete ( NativeModules as { TextFile?: unknown } ).TextFile;
  } );

  const cacheAndServe = async ( module: typeof HttpCache ) => {
    const cache = module.createHttpCache( {
      fetch: network as unknown as typeof fetch,
      storage,
      isOnline: ( ) => true,
      indexWriteDelayMs: 0,
    } );
    network.mockResolvedValueOnce( jsonResponse( ) );
    await ( await cache.fetch( URL ) ).text( );
    await settle( );
    network.mockRejectedValueOnce( new TypeError( "Network request failed" ) );
    return ( await cache.fetch( URL ) ).text( );
  };

  it( "reads and writes bodies through TextFile when it's there", async ( ) => {
    const files = new Map<string, string>( );
    const textFile = {
      writeUtf8: jest.fn( async ( path: string, contents: string ) => {
        files.set( path, contents );
      } ),
      readUtf8: jest.fn( async ( path: string ) => files.get( path ) as string ),
    };
    ( NativeModules as { TextFile?: unknown } ).TextFile = textFile;
    const { module, fs } = loadHttpCache( );

    expect( await cacheAndServe( module ) ).toEqual( BODY );
    expect( textFile.writeUtf8 ).toHaveBeenCalledWith(
      expect.stringMatching( /inatHttpCache\/\w+\.json$/ ),
      BODY,
    );
    expect( textFile.readUtf8 ).toHaveBeenCalledTimes( 1 );
    expect( fs.writeFile ).not.toHaveBeenCalled( );
    expect( fs.readFile ).not.toHaveBeenCalled( );

    const stats = module.takeHttpCacheStats( );
    expect( stats ).toMatchObject( {
      native: true,
      write: { n: 1, chars: BODY.length },
      read: { n: 1, chars: BODY.length },
      failures: 0,
    } );
    expect( module.takeHttpCacheStats( ) ).toMatchObject( { read: { n: 0 }, write: { n: 0 } } );
  } );

  it( "falls back to react-native-fs without TextFile", async ( ) => {
    const { module, fs } = loadHttpCache( );

    expect( await cacheAndServe( module ) ).toEqual( BODY );
    expect( fs.writeFile ).toHaveBeenCalledWith(
      expect.stringMatching( /inatHttpCache\/\w+\.json$/ ),
      BODY,
      "utf8",
    );
    expect( fs.readFile ).toHaveBeenCalledWith( expect.any( String ), "utf8" );
    expect( module.takeHttpCacheStats( ) ).toMatchObject( {
      native: false, write: { n: 1 }, read: { n: 1 },
    } );
  } );

  it( "counts a failed read and tells the listener", async ( ) => {
    const listener = jest.fn( );
    ( NativeModules as { TextFile?: unknown } ).TextFile = {
      writeUtf8: jest.fn( async ( ) => undefined ),
      readUtf8: jest.fn( async ( ) => { throw new Error( "ENOENT" ); } ),
    };
    const { module } = loadHttpCache( );
    module.setHttpCacheStatsListener( listener );

    await expect( cacheAndServe( module ) ).rejects.toThrow( "Network request failed" );
    expect( module.takeHttpCacheStats( ) ).toMatchObject( {
      write: { n: 1 }, read: { n: 0 }, failures: 1,
    } );
    expect( listener ).toHaveBeenCalledTimes( 2 );
  } );
} );
