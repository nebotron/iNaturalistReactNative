import { exists } from "@dr.pogodin/react-native-fs";
import { act } from "@testing-library/react-native";
import { Image, NativeModules } from "react-native";

const createThumbnail = jest.fn(
  inputPath => Promise.resolve( `file:///thumbs/${inputPath}.jpg` ),
);
const detectSubjectBounds = jest.fn( ( ) => Promise.resolve( {
  x: 0.4, y: 0.4, width: 0.2, height: 0.2,
} ) );

// Both modules capture NativeModules.ImageCropper at import time, so the mock
// has to be in place before they are required.
NativeModules.ImageCropper = { createThumbnail, detectSubjectBounds };
// eslint-disable-next-line global-require
const preloadGroupPhotoSubjectDetection = require(
  "components/PhotoImporter/helpers/preloadGroupPhotoSubjectDetection",
).default;

const groupsOf = uris => uris.map( uri => ( { photos: [{ image: { uri } }] } ) );

// The preload walks each photo through a thumbnail and then a detection, so
// let several rounds of microtasks settle.
const flush = async ( ) => {
  await act( async ( ) => {
    for ( let i = 0; i < 20; i += 1 ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise( resolve => { setImmediate( resolve ); } );
    }
  } );
};

beforeEach( ( ) => {
  createThumbnail.mockClear( );
  detectSubjectBounds.mockClear( );
  exists.mockResolvedValue( false );
  jest.spyOn( Image, "getSize" ).mockImplementation( ( uri, success ) => success( 800, 600 ) );
} );

describe( "preloadGroupPhotoSubjectDetection", ( ) => {
  it( "detects every photo in the import, not just a screenful", async ( ) => {
    const uris = Array.from( { length: 12 }, ( _, i ) => `ph://all-${i}` );

    preloadGroupPhotoSubjectDetection( groupsOf( uris ), 128 );
    await flush( );

    expect( detectSubjectBounds ).toHaveBeenCalledTimes( uris.length );
  } );

  it( "does not redo a photo it has already walked", async ( ) => {
    const uris = ["ph://again-0", "ph://again-1"];

    preloadGroupPhotoSubjectDetection( groupsOf( uris ), 128 );
    await flush( );
    expect( detectSubjectBounds ).toHaveBeenCalledTimes( 2 );

    // Combining, removing, or selecting photos re-renders the grid, which
    // restarts the preload; the photos already framed must not be queued again.
    preloadGroupPhotoSubjectDetection( groupsOf( uris ), 128 );
    await flush( );
    expect( detectSubjectBounds ).toHaveBeenCalledTimes( 2 );
  } );

  it( "detects against the uncropped original of an already cropped photo", async ( ) => {
    const groups = [{
      photos: [{
        image: {
          uri: "file:///cropped-copy.jpg",
          cropOriginalUri: "ph://original-1",
        },
      }],
    }];

    preloadGroupPhotoSubjectDetection( groups, 128 );
    await flush( );

    expect( createThumbnail ).toHaveBeenCalledWith(
      "ph://original-1",
      expect.any( Number ),
      expect.any( String ),
    );
  } );
} );
