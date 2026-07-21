import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import {
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import {
  navigateToPhotoImporterFromMyObs,
} from "tests/helpers/addObsBottomSheet";
import { renderApp } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";

// We're explicitly testing navigation here so we want react-navigation
// working normally
jest.unmock( "@react-navigation/native" );

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

beforeAll( async () => {
  await initI18next();
  jest.useFakeTimers( );
} );

const mockNode1 = {
  id: "MOCK-ID-1",
  type: "image",
  group_name: "Camera Roll",
  image: {
    filename: "IMG_0001.jpg",
    filepath: "/path/to/IMG_0001.jpg",
    extension: "jpg",
    uri: "file:///path/to/IMG_0001.jpg",
    height: 1920,
    width: 1080,
    fileSize: 123456,
    playableDuration: NaN,
    orientation: 1,
  },
  timestamp: 1234567890,
  location: null,
};

const mockNode2 = {
  ...mockNode1,
  id: "MOCK-ID-2",
  image: {
    ...mockNode1.image,
    filename: "IMG_0002.jpg",
    filepath: "/path/to/IMG_0002.jpg",
    uri: "file:///path/to/IMG_0002.jpg",
  },
};

const makeGetPhotosResult = nodes => ( {
  page_info: { end_cursor: undefined, has_next_page: false },
  edges: nodes.map( node => ( { node } ) ),
} );

describe( "PhotoLibrary navigation", ( ) => {
  global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

  beforeEach( ( ) => {
    setStoreStateLayout( {
      isDefaultMode: false,
      isAllAddObsOptionsMode: true,
    } );
  } );

  it( "advances to GroupPhotos when multiple photos are selected", async ( ) => {
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [mockNode1, mockNode2] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs( );

    await waitFor( ( ) => {
      expect(
        screen.getByTestId( `PhotoGallery.${mockNode1.image.uri}` ),
      ).toBeTruthy( );
    }, { timeout: 10_000 } );

    fireEvent.press( screen.getByTestId( `PhotoGallery.${mockNode1.image.uri}` ) );
    fireEvent.press( screen.getByTestId( `PhotoGallery.${mockNode2.image.uri}` ) );
    fireEvent.press( screen.getByTestId( "PhotoGallery.done" ) );

    await waitFor( ( ) => {
      expect( screen.getByText( /Group Photos/ ) ).toBeVisible( );
    }, { timeout: 10_000 } );
  } );

  it( "advances to GroupPhotos when one photo is selected", async ( ) => {
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [mockNode1] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs( );

    await waitFor( ( ) => {
      expect(
        screen.getByTestId( `PhotoGallery.${mockNode1.image.uri}` ),
      ).toBeTruthy( );
    }, { timeout: 10_000 } );

    fireEvent.press( screen.getByTestId( `PhotoGallery.${mockNode1.image.uri}` ) );
    fireEvent.press( screen.getByTestId( "PhotoGallery.done" ) );

    await waitFor( ( ) => {
      expect( screen.getByText( /Group Photos/ ) ).toBeVisible( );
    }, { timeout: 10_000 } );
  } );
} );
