import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import React from "react";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

const mockDeleteOriginalDevicePhotos = jest.fn( async () => undefined );
jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", () => ( {
  __esModule: true,
  default: jest.fn(),
  deleteOriginalDevicePhotos: ( ...args ) => mockDeleteOriginalDevicePhotos( ...args ),
} ) );

const initialStoreState = useStore.getState( );

describe( "GroupPhotos delete syncs to device", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    jest.clearAllMocks( );
  } );

  it( "deletes the removed photo from the device", async ( ) => {
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

    await waitFor( () => {
      expect( mockDeleteOriginalDevicePhotos ).toHaveBeenCalledWith(
        ["ph://DEVICE-1"],
        expect.anything(),
      );
    } );
  } );
} );
