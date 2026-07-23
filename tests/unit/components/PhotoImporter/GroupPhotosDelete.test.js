import { fireEvent, screen } from "@testing-library/react-native";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import React from "react";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const initialStoreState = useStore.getState( );

describe( "GroupPhotos delete syncs to device", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    jest.clearAllMocks( );
  } );

  // Removing a photo stages its device URI for deletion (the actual delete runs
  // at import time on the stable My Observations screen, because iOS can't
  // present its deletion confirmation over the modal Group Photos screen).
  it( "stages the removed photo's device URI for deletion", async ( ) => {
    useStore.setState( {
      groupedPhotos: [{
        photos: [{
          image: { uri: "file:///local_1.jpg" },
          originalDevicePhotoUri: "ph://DEVICE-1",
        }],
      }],
    } );
    renderComponent( <GroupPhotosContainer /> );

    fireEvent.press( screen.getByTestId( "GroupPhotos.file:///local_1.jpg" ) );
    fireEvent.press( screen.getByLabelText( /Remove Photos/ ) );

    expect( useStore.getState( ).pendingGroupPhotoDeletionUris ).toContain( "ph://DEVICE-1" );
  } );
} );
