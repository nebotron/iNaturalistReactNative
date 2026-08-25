import { fireEvent, screen } from "@testing-library/react-native";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import initI18next from "i18n/initI18next";
import React from "react";
import {
  clearRemovedGroupPhotoUris,
  getRemovedGroupPhotoUris,
} from "sharedHelpers/removedGroupPhotoUris";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";

jest.mock( "@react-navigation/native", ( ) => {
  const actualNav = jest.requireActual( "@react-navigation/native" );
  return {
    ...actualNav,
    useNavigation: ( ) => ( {
      navigate: jest.fn( ),
      goBack: jest.fn( ),
      push: jest.fn( ),
      canGoBack: jest.fn( ( ) => false ),
      dispatch: jest.fn( ),
      addListener: jest.fn( ( ) => jest.fn( ) ),
      setOptions: jest.fn( ),
    } ),
  };
} );

const initialStoreState = useStore.getState( );

describe( "GroupPhotos delete syncs to device", ( ) => {
  beforeAll( async ( ) => {
    await initI18next( );
  } );

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

  // Removing a photo is a decision about the photo, not about the import, so
  // abandoning the import leaves it recorded for Photo Cleanup.
  it( "keeps the removed photo's device URI after discarding the import", async ( ) => {
    useStore.setState( {
      groupedPhotos: [
        {
          photos: [{
            image: { uri: "file:///local_1.jpg" },
            originalDevicePhotoUri: "ph://DEVICE-1",
          }],
        },
        {
          photos: [{
            image: { uri: "file:///local_2.jpg" },
            originalDevicePhotoUri: "ph://DEVICE-2",
          }],
        },
      ],
    } );
    renderComponent( <GroupPhotosContainer /> );

    fireEvent.press( screen.getByTestId( "GroupPhotos.remove.file:///local_1.jpg" ) );
    fireEvent.press( screen.getByTestId( "GroupPhotos.discard" ) );
    fireEvent.press( screen.getByText( "DISCARD ALL" ) );

    expect( getRemovedGroupPhotoUris( ) ).toContain( "ph://DEVICE-1" );
    expect( getRemovedGroupPhotoUris( ) ).not.toContain( "ph://DEVICE-2" );
  } );
} );
