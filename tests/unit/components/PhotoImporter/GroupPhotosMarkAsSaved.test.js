import { fireEvent, screen } from "@testing-library/react-native";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import React from "react";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import useStore from "stores/useStore";
import { renderComponent } from "tests/helpers/render";
import setupUniqueRealm from "tests/helpers/uniqueRealm";

// UNIQUE REALM SETUP
const mockRealmIdentifier = __filename;
const { mockRealmModelsIndex, uniqueRealmBeforeAll, uniqueRealmAfterAll } = setupUniqueRealm(
  mockRealmIdentifier,
);
jest.mock( "realmModels/index", ( ) => mockRealmModelsIndex );
jest.mock( "providers/contexts", ( ) => {
  const originalModule = jest.requireActual( "providers/contexts" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      useRealm: ( ) => global.mockRealms[mockRealmIdentifier],
      useQuery: ( ) => [],
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const initialStoreState = useStore.getState( );

describe( "GroupPhotos mark as saved", ( ) => {
  beforeEach( ( ) => {
    useStore.setState( initialStoreState, true );
    jest.clearAllMocks( );
  } );

  // Marking selected photos as saved records their device URIs as already
  // uploaded, which is what the photo picker's "Hide Saved" toggle filters on.
  it( "records the selected photo's device URI as already uploaded", async ( ) => {
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
    fireEvent.press( screen.getByTestId( "GroupPhotos.markAsSaved" ) );

    const uploadedUris = getPreviouslyUploadedDevicePhotoUrisSet(
      global.mockRealms[mockRealmIdentifier],
    );
    expect( uploadedUris.has( "ph://DEVICE-1" ) ).toBe( true );
  } );
} );
