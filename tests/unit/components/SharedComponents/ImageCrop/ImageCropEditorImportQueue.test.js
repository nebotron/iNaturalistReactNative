import { useRoute } from "@react-navigation/native";
import { act, screen } from "@testing-library/react-native";
import ImageCropEditor from "components/SharedComponents/ImageCrop/ImageCropEditor";
import React from "react";
import { preloadCache } from "sharedHelpers/imageCropPreload";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const DEVICE_URI = "ph://asset_1";
const IMPORTED_URI = "file:///imported_1.jpg";
const ALREADY_IN_GRID_URI = "file:///imported_0.jpg";

const mockPreloadResult = uri => ( {
  localUri: uri,
  size: { w: 100, h: 100 },
  crop: {
    x: 0, y: 0, w: 1, h: 1,
  },
} );

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
    default: ( { sourceUri } ) => MockReact.createElement(
      MockText,
      { testID: "ImageCropView" },
      sourceUri,
    ),
  };
} );

const initialStoreState = useStore.getState( );

describe( "ImageCropEditor cropping a photo library import", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    preloadCache.clear( );
  } );

  afterEach( ( ) => {
    preloadCache.clear( );
    useRoute.mockReturnValue( { params: {} } );
  } );

  // The picker sends the user here while the photos are still being copied out
  // of the library, so the queue is whatever the import has landed so far.
  it( "crops a photo as soon as the import lands it", async ( ) => {
    useRoute.mockReturnValue( {
      params: { context: "groupPhotos", cropImport: true },
    } );
    useStore.setState( {
      groupedPhotos: [{ photos: [{ image: { uri: DEVICE_URI }, pending: true }] }],
    } );
    renderComponent( <ImageCropEditor /> );
    expect( screen.queryByTestId( "ImageCropView" ) ).toBeNull( );

    preloadCache.set( IMPORTED_URI, mockPreloadResult( IMPORTED_URI ) );
    act( ( ) => {
      useStore.setState( {
        groupedPhotos: [{ photos: [{ image: { uri: IMPORTED_URI } }] }],
      } );
    } );

    expect( await screen.findByTestId( "ImageCropView" ) ).toBeVisible( );
  } );

  // Coming back to the picker to add more photos crops the ones being added,
  // not the ones the user already has in the grid.
  it( "skips photos that were in the grid before the batch was picked", async ( ) => {
    useRoute.mockReturnValue( {
      params: {
        context: "groupPhotos",
        cropImport: true,
        skipUris: [ALREADY_IN_GRID_URI],
      },
    } );
    preloadCache.set( ALREADY_IN_GRID_URI, mockPreloadResult( ALREADY_IN_GRID_URI ) );
    preloadCache.set( IMPORTED_URI, mockPreloadResult( IMPORTED_URI ) );
    useStore.setState( {
      groupedPhotos: [
        { photos: [{ image: { uri: ALREADY_IN_GRID_URI } }] },
        { photos: [{ image: { uri: DEVICE_URI }, pending: true }] },
      ],
    } );
    renderComponent( <ImageCropEditor /> );
    expect( screen.queryByTestId( "ImageCropView" ) ).toBeNull( );

    act( ( ) => {
      useStore.setState( {
        groupedPhotos: [
          { photos: [{ image: { uri: ALREADY_IN_GRID_URI } }] },
          { photos: [{ image: { uri: IMPORTED_URI } }] },
        ],
      } );
    } );

    expect( await screen.findByTestId( "ImageCropView" ) ).toHaveTextContent( IMPORTED_URI );
  } );
} );
