import { act, renderHook } from "@testing-library/react-native";
import { Image, NativeModules } from "react-native";
import useThumbnailSubjectDetection, {
  resolveThumbnailSubjectDetection,
} from "sharedHelpers/useThumbnailSubjectDetection";

const MAX_CONCURRENT = 3;

// Resolvers for every native detection still in flight, keyed by the path it
// was asked to detect in.
const pending = new Map( );
const detectSubjectBounds = jest.fn( inputPath => new Promise( resolve => {
  pending.set( inputPath, resolve );
} ) );

const thumbnailFor = uri => `file:///thumbs/${uri}.jpg`;

const flush = async ( ) => {
  await act( async ( ) => {
    await new Promise( resolve => { setImmediate( resolve ); } );
  } );
};

const finishDetection = async inputPath => {
  const resolve = pending.get( inputPath );
  pending.delete( inputPath );
  resolve( {
    x: 0.4, y: 0.4, width: 0.2, height: 0.2,
  } );
  await flush( );
};

const render = ( uri, hasSavedCrop = false ) => renderHook(
  ( ) => useThumbnailSubjectDetection( uri, thumbnailFor( uri ), hasSavedCrop ),
);

beforeEach( ( ) => {
  detectSubjectBounds.mockClear( );
  NativeModules.ImageCropper = { detectSubjectBounds };
  jest.spyOn( Image, "getSize" ).mockImplementation( ( uri, success ) => success( 800, 600 ) );
} );

// Leave no detection holding a concurrency slot: the queue is module state
// shared by every test in this file.
afterEach( async ( ) => {
  /* eslint-disable no-await-in-loop */
  while ( pending.size > 0 ) {
    const paths = [...pending.keys( )];
    for ( let i = 0; i < paths.length; i += 1 ) {
      await finishDetection( paths[i] );
    }
  }
  /* eslint-enable no-await-in-loop */
} );

describe( "useThumbnailSubjectDetection", ( ) => {
  it( "detects in the thumbnail, not the full-resolution original", async ( ) => {
    const { result } = render( "ph://thumbnail-not-original" );
    await flush( );

    expect( detectSubjectBounds ).toHaveBeenCalledWith( "/thumbs/ph://thumbnail-not-original.jpg" );
    await finishDetection( "/thumbs/ph://thumbnail-not-original.jpg" );

    // Dimensions come from the thumbnail; only their ratio is ever used
    expect( result.current.imageWidth ).toBe( 800 );
    expect( result.current.imageHeight ).toBe( 600 );
    expect( result.current.crop.w ).toBeGreaterThan( 0 );
  } );

  it( "skips detection when the photo already has a saved crop", async ( ) => {
    const { result } = render( "ph://has-saved-crop", true );
    await flush( );

    expect( detectSubjectBounds ).not.toHaveBeenCalled( );
    expect( result.current.imageWidth ).toBe( 800 );
    expect( result.current.crop ).toBeNull( );
  } );

  it( "runs no more than the concurrency cap at once", async ( ) => {
    const uris = ["a", "b", "c", "d", "e"].map( name => `ph://concurrency-${name}` );
    uris.forEach( uri => render( uri ) );
    await flush( );

    expect( detectSubjectBounds ).toHaveBeenCalledTimes( MAX_CONCURRENT );

    await finishDetection( `/thumbs/${uris[0]}.jpg` );
    expect( detectSubjectBounds ).toHaveBeenCalledTimes( MAX_CONCURRENT + 1 );
  } );

  it( "runs an on-screen cell ahead of preloaded photos already queued", async ( ) => {
    const uris = ["a", "b", "c", "d", "e"].map( name => `ph://preload-${name}` );
    uris.forEach(
      uri => resolveThumbnailSubjectDetection( uri, thumbnailFor( uri ), false, true ),
    );
    await flush( );

    // Every slot is busy, so preload-d and preload-e are queued behind them.
    expect( detectSubjectBounds ).toHaveBeenCalledTimes( MAX_CONCURRENT );

    render( "ph://preload-visible" );
    await flush( );
    await finishDetection( thumbnailFor( uris[0] ).replace( "file://", "" ) );

    // The whole import is being warmed in the background, so a cell scrolled
    // into view must not wait out the backlog before it can frame its crop.
    const detected = detectSubjectBounds.mock.calls.map( call => call[0] );
    expect( detected ).toContain( "/thumbs/ph://preload-visible.jpg" );
    expect( detected ).not.toContain( "/thumbs/ph://preload-d.jpg" );
  } );

  it( "detects once per photo no matter how many cells ask", async ( ) => {
    render( "ph://deduped" );
    render( "ph://deduped" );
    await flush( );

    expect( detectSubjectBounds ).toHaveBeenCalledTimes( 1 );
  } );
} );
