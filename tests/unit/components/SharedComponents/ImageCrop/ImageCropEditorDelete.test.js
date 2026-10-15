import { useRoute } from "@react-navigation/native";
import { fireEvent, screen } from "@testing-library/react-native";
import ImageCropEditor from "components/SharedComponents/ImageCrop/ImageCropEditor";
import React from "react";
import { preloadCache } from "sharedHelpers/imageCropPreload";
import {
  clearRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

// The cropper itself is all gestures and reanimated; we only care about what
// its delete button does
jest.mock( "components/SharedComponents/ImageCrop/ImageCropView", ( ) => {
  const { Pressable: MockPressable, Text: MockText } = jest.requireActual( "react-native" );
  const MockReact = jest.requireActual( "react" );
  return {
    __esModule: true,
    default: ( { onDelete } ) => MockReact.createElement(
      MockPressable,
      { testID: "ImageCropView.delete", onPress: onDelete },
      MockReact.createElement( MockText, null, "delete" ),
    ),
  };
} );

const DISPLAY_URI = "file:///local_1.jpg";
const DEVICE_URI = "ph://DEVICE-1";

const initialStoreState = useStore.getState( );

describe( "ImageCropEditor delete from Group Photos", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    clearRemovedGroupPhotoUris( getRemovedGroupPhotoUris( ) );
    // Seeds the editor so it renders the cropper instead of the spinner
    preloadCache.set( DISPLAY_URI, {
      localUri: DISPLAY_URI,
      displayUri: DISPLAY_URI,
      size: { w: 100, h: 100 },
      crop: {
        x: 0, y: 0, width: 1, height: 1,
      },
    } );
    useRoute.mockReturnValue( {
      params: { imageUri: DISPLAY_URI, context: "groupPhotos" },
    } );
  } );

  afterEach( ( ) => {
    preloadCache.delete( DISPLAY_URI );
    useRoute.mockReturnValue( { params: {} } );
  } );

  // Deleting in the cropper is the same user intent as removing from the Group
  // Photos grid, so it has to leave the same trail: staged for device deletion
  // and recorded as removed, which is what keeps it out of the photo picker.
  it( "stages the photo for device deletion and records it as removed", ( ) => {
    useStore.setState( {
      groupedPhotos: [{
        photos: [{
          image: { uri: DISPLAY_URI },
          originalDevicePhotoUri: DEVICE_URI,
        }],
      }],
    } );
    renderComponent( <ImageCropEditor /> );

    fireEvent.press( screen.getByTestId( "ImageCropView.delete" ) );

    expect( useStore.getState( ).pendingGroupPhotoDeletionUris ).toContain( DEVICE_URI );
    expect( getRemovedGroupPhotoUris( ) ).toContain( DEVICE_URI );
    expect( useStore.getState( ).groupedPhotos ).toHaveLength( 0 );
  } );
} );
