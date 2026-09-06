import { useRoute } from "@react-navigation/native";
import { act, screen } from "@testing-library/react-native";
import ImageCropEditor from "components/SharedComponents/ImageCrop/ImageCropEditor";
import React from "react";
import { preloadCache } from "sharedHelpers/imageCropPreload";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const DISPLAY_URI = "file:///local_1.jpg";

const mockPreloadResult = {
  localUri: DISPLAY_URI,
  displayUri: DISPLAY_URI,
  size: { w: 100, h: 100 },
  crop: {
    x: 0, y: 0, w: 1, h: 1,
  },
};

// Models the real module: a cache callers read directly, and a loader that
// resolves from that cache when it already holds the URI. The first load is
// left hanging so the test controls when the cache gets filled.
jest.mock( "sharedHelpers/imageCropPreload", ( ) => {
  const cache = new Map( );
  return {
    preloadCache: cache,
    enqueuePreload: jest.fn( ( ) => Promise.resolve( null ) ),
    preloadImage: jest.fn( uri => {
      const cached = cache.get( uri );
      return cached
        ? Promise.resolve( cached )
        : new Promise( ( ) => {} );
    } ),
  };
} );

jest.mock( "components/SharedComponents/ImageCrop/ImageCropView", ( ) => {
  const { Text: MockText } = jest.requireActual( "react-native" );
  const MockReact = jest.requireActual( "react" );
  return {
    __esModule: true,
    default: ( ) => MockReact.createElement( MockText, { testID: "ImageCropView" }, "cropper" ),
  };
} );

const initialStoreState = useStore.getState( );

describe( "ImageCropEditor loading the image to crop", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    preloadCache.clear( );
    useRoute.mockReturnValue( {
      params: { imageUri: DISPLAY_URI, context: "groupPhotos" },
    } );
  } );

  afterEach( ( ) => {
    preloadCache.clear( );
    useRoute.mockReturnValue( { params: {} } );
  } );

  // The load effect re-runs on any store write, and a re-run cancels the load
  // in flight. When that cancelled load is the one that filled the cache,
  // nothing is left to apply it, and the screen used to sit on its spinner for
  // good.
  it( "shows the cropper when a store change cancels the load that loaded it", async ( ) => {
    renderComponent( <ImageCropEditor /> );
    expect( screen.queryByTestId( "ImageCropView" ) ).toBeNull( );

    // The in-flight load lands, then a store write re-runs (and cancels) it
    preloadCache.set( DISPLAY_URI, mockPreloadResult );
    act( ( ) => {
      useStore.setState( {
        groupedPhotos: [{ photos: [{ image: { uri: DISPLAY_URI } }] }],
      } );
    } );

    expect( await screen.findByTestId( "ImageCropView" ) ).toBeTruthy( );
  } );
} );
