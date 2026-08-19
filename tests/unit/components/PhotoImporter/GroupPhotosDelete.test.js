import { fireEvent, screen } from "@testing-library/react-native";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import React from "react";
import {
  clearRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const initialStoreState = useStore.getState( );

describe( "GroupPhotos delete syncs to device", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    clearRemovedGroupPhotoUris( getRemovedGroupPhotoUris( ) );
    jest.clearAllMocks( );
  } );

  // Removing a photo records its device URI instead of deleting it: the import
  // never touches the photo library, and the URI is offered later in Photo
  // Cleanup.
  it( "records the removed photo's device URI for later cleanup", async ( ) => {
    useStore.setState( {
      groupedPhotos: [{
        photos: [{
          image: { uri: "file:///local_1.jpg" },
          originalDevicePhotoUri: "ph://DEVICE-1",
        }],
      }],
    } );
    renderComponent( <GroupPhotosContainer /> );

    fireEvent.press( screen.getByTestId( "GroupPhotos.remove.file:///local_1.jpg" ) );

    expect( useStore.getState( ).pendingGroupPhotoDeletionUris ).toContain( "ph://DEVICE-1" );
    expect( getRemovedGroupPhotoUris( ) ).toContain( "ph://DEVICE-1" );
  } );
} );
