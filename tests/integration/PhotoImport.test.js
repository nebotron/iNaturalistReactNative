import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import {
  fireEvent,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import {
  mockInteractionManagerRunAfterInteractions,
  navigateToPhotoImporterFromMyObs,
  waitForMyObsGridItems,
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
  const { makeRealmHooks } = jest.requireActual( "tests/helpers/uniqueRealm" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      ...makeRealmHooks( __filename ),
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const mockUser = require( "tests/factory" ).default( "LocalUser" );
// Mock useCurrentUser hook
jest.mock( "sharedHooks/useCurrentUser", () => ( {
  __esModule: true,
  default: jest.fn( () => mockUser ),
} ) );

jest.mock( "sharedHooks/useObservationCounts", () => {
  const { UNSYNCED_FILTER } = jest.requireActual( "realmModels/Observation" );
  return {
    __esModule: true,
    default: () => {
      const realm = global.mockRealms[__filename];
      if ( !realm ) return { numUnuploadedObservations: 0, numObsMissingBasics: 0 };
      const unsynced = realm.objects( "Observation" ).filtered( UNSYNCED_FILTER );
      return {
        numUnuploadedObservations: unsynced.length,
        numObsMissingBasics: unsynced
          .filter( obs => obs.missingBasics( ) ).length,
      };
    },
  };
} );

beforeAll( async () => {
  await initI18next();
  mockInteractionManagerRunAfterInteractions( );
} );

const galleryPath = "file://document/directory/path/galleryPhotos";

const mockNode1 = {
  id: "MOCK-ID-1",
  type: "image",
  group_name: "Camera Roll",
  image: {
    filename: "some_file_name.jpg",
    filepath: "/path/to/some_file_name.jpg",
    extension: "jpg",
    uri: "file:///path/to/some_file_name.jpg",
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
    filename: "another_file_name.jpg",
    filepath: "/path/to/another_file_name.jpg",
    uri: "file:///path/to/another_file_name.jpg",
  },
  timestamp: 1234567891,
};

const makeGetPhotosResult = nodes => ( {
  page_info: { end_cursor: undefined, has_next_page: false },
  edges: nodes.map( node => ( { node } ) ),
} );

describe( "Photo Import", ( ) => {
  global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

  const actor = userEvent.setup( );

  beforeEach( async () => {
    setStoreStateLayout( {
      isDefaultMode: false,
      isAllAddObsOptionsMode: true,
    } );
  } );

  async function selectPhotosInGallery( nodes ) {
    await waitFor( ( ) => {
      expect( screen.getByTestId( `PhotoGallery.${nodes[0].image.uri}` ) ).toBeTruthy( );
    }, { timeout: 10_000 } );
    for ( const node of nodes ) {
      fireEvent.press( screen.getByTestId( `PhotoGallery.${node.image.uri}` ) );
    }
    fireEvent.press( screen.getByTestId( "PhotoGallery.done" ) );
  }

  async function groupPhotosIntoObservation() {
    await waitFor( ( ) => {
      expect( screen.getByText( /Group Photos/ ) ).toBeVisible( );
    }, { timeout: 10_000 } );
    const firstUri = `${galleryPath}/${mockNode1.image.filename}`;
    const secondUri = `${galleryPath}/${mockNode2.image.filename}`;
    const firstPhoto = await screen.findByTestId( `GroupPhotos.${firstUri}` );
    await actor.press( firstPhoto );
    const secondPhoto = await screen.findByTestId( `GroupPhotos.${secondUri}` );
    await actor.press( secondPhoto );
    const combineButton = await screen.findByLabelText( /Combine Photos/ );
    await actor.press( combineButton );
    const importButton = await screen.findByText( /IMPORT 1 OBSERVATION/ );
    await actor.press( importButton );
  }

  it( "should create and save an observation with an imported photo", async ( ) => {
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [mockNode1] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await selectPhotosInGallery( [mockNode1] );

    await waitFor( ( ) => {
      expect( screen.getByText( /Group Photos/ ) ).toBeVisible( );
    }, { timeout: 10_000 } );
    const importButton = await screen.findByText( /IMPORT 1 OBSERVATION/ );
    await actor.press( importButton );

    const obsGridItems = await waitForMyObsGridItems();
    expect( obsGridItems[0] ).toBeVisible();
    await screen.findByText( /Upload \d observation/ );
  } );

  it( "should create and save an observation with multiple imported photos", async ( ) => {
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [mockNode1, mockNode2] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await selectPhotosInGallery( [mockNode1, mockNode2] );
    await groupPhotosIntoObservation();

    const obsGridItems = await waitForMyObsGridItems();
    expect( obsGridItems[0] ).toBeVisible();
  } );
} );
