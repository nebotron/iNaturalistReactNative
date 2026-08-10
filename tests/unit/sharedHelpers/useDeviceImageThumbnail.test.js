import { CachesDirectoryPath, exists, unlink } from "@dr.pogodin/react-native-fs";
import { act, renderHook } from "@testing-library/react-native";
import { NativeModules } from "react-native";

const cachedThumbnailPath = `${CachesDirectoryPath}/inatDeviceThumbnails`;

const MAX_CONCURRENCY = 4;

// Resolvers for every native thumbnail generation still in flight, keyed by
// the uri it was asked to generate.
const pending = new Map( );
const createThumbnail = jest.fn( inputPath => new Promise( resolve => {
  pending.set( inputPath, resolve );
} ) );

// The module captures NativeModules.ImageCropper at import time, so the mock
// has to be in place before it is required (an import would be hoisted above
// this assignment).
NativeModules.ImageCropper = { createThumbnail };
// eslint-disable-next-line global-require
const thumbnails = require( "sharedHelpers/useDeviceImageThumbnail" );

const useDeviceImageThumbnail = thumbnails.default;
const { invalidateDeviceImageThumbnail, prefetchDeviceImageThumbnails } = thumbnails;

// Generation goes through several awaits (mkdir, exists, the native call), so
// let every pending microtask settle.
const flush = async ( ) => {
  await act( async ( ) => {
    await new Promise( resolve => { setImmediate( resolve ); } );
  } );
};

const finish = async ( uri, thumbnailUri = `file:///thumbs/${uri}.jpg` ) => {
  const resolve = pending.get( uri );
  pending.delete( uri );
  resolve( thumbnailUri );
  await flush( );
};

const startedUris = ( ) => createThumbnail.mock.calls.map( call => call[0] );

beforeEach( ( ) => {
  createThumbnail.mockClear( );
  exists.mockResolvedValue( false );
} );

// Leave no job holding a concurrency slot, since the queue is module state
// shared by every test in this file.
afterEach( async ( ) => {
  /* eslint-disable no-await-in-loop */
  while ( pending.size > 0 ) {
    const uris = [...pending.keys( )];
    for ( let i = 0; i < uris.length; i += 1 ) {
      await finish( uris[i] );
    }
  }
  /* eslint-enable no-await-in-loop */
} );

describe( "useDeviceImageThumbnail", ( ) => {
  it( "runs no more than the concurrency cap at once", async ( ) => {
    const uris = ["a1", "a2", "a3", "a4", "a5", "a6"].map( name => `ph://${name}` );

    prefetchDeviceImageThumbnails( uris, 300 );
    await flush( );

    expect( createThumbnail ).toHaveBeenCalledTimes( MAX_CONCURRENCY );
  } );

  it( "serves the backlog newest-first", async ( ) => {
    const uris = ["b1", "b2", "b3", "b4", "b5", "b6"].map( name => `ph://${name}` );

    prefetchDeviceImageThumbnails( uris, 300 );
    await flush( );
    // b5 and b6 are queued behind the four that started.
    await finish( "ph://b1" );

    // The most recently requested photo runs next, so a fresh request never
    // waits behind everything already scrolled past.
    expect( startedUris( ) ).toContain( "ph://b6" );
    expect( startedUris( ) ).not.toContain( "ph://b5" );
  } );

  it( "prioritizes a visible cell over queued prefetches", async ( ) => {
    const uris = ["c1", "c2", "c3", "c4", "c5", "c6"].map( name => `ph://${name}` );

    prefetchDeviceImageThumbnails( uris, 300 );
    await flush( );
    renderHook( ( ) => useDeviceImageThumbnail( "ph://visible", 300 ) );
    await flush( );

    // Every slot is busy, so nothing new starts yet.
    expect( createThumbnail ).toHaveBeenCalledTimes( MAX_CONCURRENCY );

    // As soon as a slot frees up the on-screen photo jumps the prefetch queue.
    await finish( "ph://c1" );
    expect( startedUris( ) ).toContain( "ph://visible" );
    expect( startedUris( ) ).not.toContain( "ph://c6" );
  } );

  it( "abandons a thumbnail whose cell was recycled away before it started", async ( ) => {
    const uris = ["d1", "d2", "d3", "d4", "d5"].map( name => `ph://${name}` );
    const hooks = uris.map( uri => renderHook( ( ) => useDeviceImageThumbnail( uri, 300 ) ) );
    await flush( );

    expect( createThumbnail ).toHaveBeenCalledTimes( MAX_CONCURRENCY );

    // ph://d5 is still queued; unmounting its cell drops it entirely rather
    // than making the next visible photo wait behind it.
    hooks[4].unmount( );
    await finish( "ph://d1" );

    expect( startedUris( ) ).not.toContain( "ph://d5" );
  } );

  it( "returns an already generated thumbnail on the first render", async ( ) => {
    const { result } = renderHook( ( ) => useDeviceImageThumbnail( "ph://e1", 300 ) );
    await flush( );
    expect( result.current ).toBeUndefined( );

    await finish( "ph://e1" );
    expect( result.current ).toEqual( "file:///thumbs/ph://e1.jpg" );

    // Scrolling back to a photo already seen must not blank the cell while a
    // fresh request round-trips.
    const { result: remounted } = renderHook(
      ( ) => useDeviceImageThumbnail( "ph://e1", 300 ),
    );
    expect( remounted.current ).toEqual( "file:///thumbs/ph://e1.jpg" );
    expect( createThumbnail ).toHaveBeenCalledTimes( 1 );
  } );

  it( "regenerates a thumbnail the caller couldn't decode", async ( ) => {
    const generated = `file://${cachedThumbnailPath}/f1.jpg`;
    renderHook( ( ) => useDeviceImageThumbnail( "ph://f1", 300 ) );
    await flush( );
    await finish( "ph://f1", generated );
    expect( createThumbnail ).toHaveBeenCalledTimes( 1 );

    await act( async ( ) => {
      await invalidateDeviceImageThumbnail( generated, "ph://f1" );
    } );

    // Without the invalidation the cache would hand the same unopenable file
    // to every cell that asks for this photo from now on.
    renderHook( ( ) => useDeviceImageThumbnail( "ph://f1", 300 ) );
    await flush( );
    expect( startedUris( ).filter( uri => uri === "ph://f1" ) ).toHaveLength( 2 );
  } );

  it( "never deletes anything outside the thumbnail cache", async ( ) => {
    exists.mockResolvedValue( true );
    unlink.mockClear( );

    await invalidateDeviceImageThumbnail( "file:///galleryPhotos/g1.CR3", "file:///g1.CR3" );

    expect( unlink ).not.toHaveBeenCalled( );
  } );
} );
