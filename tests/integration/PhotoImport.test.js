import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import {
  fireEvent,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import { NativeModules } from "react-native";
import { recordUploadedDevicePhotoUris } from "sharedHelpers/duplicateUploadedDevicePhotos";
import {
  mockInteractionManagerRunAfterInteractions,
  navigateToPhotoImporterFromMyObs,
  waitForMyObservationsScreen,
  waitForMyObsGridItems,
} from "tests/helpers/addObsBottomSheet";
import { renderApp } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";

// We're explicitly testing navigation here so we want react-navigation
// working normally
jest.unmock( "@react-navigation/native" );

// Importing writes the original asset's bytes out through this native module,
// and there's no fallback: without it every copy fails and no import can
// produce anything.
NativeModules.ImageCropper = {
  ...NativeModules.ImageCropper,
  exportPHAsset: async ( phUri, destPath ) => ( { uri: destPath, attempts: 1 } ),
};

// Imported observations are saved in the background after the user has already
// been sent back to My Observations, so a test that wants to be the user
// starting another import mid-save needs that background work to still be
// running. Only the test that cares sets a delay.
global.mockSaveObservationsDelayMs = 0;
jest.mock( "sharedHelpers/applyTrackedLocationToPhotos", ( ) => {
  const actual = jest.requireActual( "sharedHelpers/applyTrackedLocationToPhotos" );
  return {
    ...actual,
    saveObservationsAndApplyTrackedLocation: async ( ...args ) => {
      if ( global.mockSaveObservationsDelayMs > 0 ) {
        await new Promise( resolve => {
          setTimeout( resolve, global.mockSaveObservationsDelayMs );
        } );
      }
      return actual.saveObservationsAndApplyTrackedLocation( ...args );
    },
  };
} );

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
      if ( !realm ) {
        return {
          numUnuploadedObservations: 0,
          numObsMissingBasics: 0,
          numUnuploadedObsNoTaxon: 0,
        };
      }
      const unsynced = realm.objects( "Observation" ).filtered( UNSYNCED_FILTER );
      return {
        numUnuploadedObservations: unsynced.length,
        numObsMissingBasics: unsynced
          .filter( obs => obs.missingBasics( ) ).length,
        numUnuploadedObsNoTaxon: unsynced
          .filter( obs => !obs.taxon ).length,
      };
    },
  };
} );

beforeAll( async () => {
  await initI18next();
  mockInteractionManagerRunAfterInteractions( );
} );

const galleryPath = "file://document/directory/path/galleryPhotos";

// The photo picker hides device photos it has already imported, and that
// history lives in this file's realm for the whole run, so every test needs
// its own photos or it inherits the previous test's imports as hidden.
const makeMockNode = ( name, timestamp ) => ( {
  id: `MOCK-ID-${name}`,
  type: "image",
  group_name: "Camera Roll",
  image: {
    filename: `${name}.jpg`,
    filepath: `/path/to/${name}.jpg`,
    extension: "jpg",
    uri: `file:///path/to/${name}.jpg`,
    height: 1920,
    width: 1080,
    fileSize: 123456,
    playableDuration: NaN,
    orientation: 1,
  },
  timestamp,
  location: null,
} );

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

  async function groupPhotosIntoObservation( firstNode, secondNode ) {
    await waitFor( ( ) => {
      expect( screen.getByTestId( "GroupPhotos.list" ) ).toBeVisible( );
    }, { timeout: 10_000 } );
    const firstUri = `${galleryPath}/${firstNode.image.filename}`;
    const secondUri = `${galleryPath}/${secondNode.image.filename}`;
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
    const node = makeMockNode( "single_import", 1234567890 );
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [node] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await selectPhotosInGallery( [node] );

    await waitFor( ( ) => {
      expect( screen.getByTestId( "GroupPhotos.list" ) ).toBeVisible( );
    }, { timeout: 10_000 } );
    const importButton = await screen.findByText( /IMPORT 1 OBSERVATION/ );
    await actor.press( importButton );

    const obsGridItems = await waitForMyObsGridItems();
    expect( obsGridItems[0] ).toBeVisible();
    await screen.findByText( /Upload \d observation/ );
  } );

  it( "should create and save an observation with multiple imported photos", async ( ) => {
    const firstNode = makeMockNode( "multi_import_first", 1234567890 );
    const secondNode = makeMockNode( "multi_import_second", 1234567891 );
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [firstNode, secondNode] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await selectPhotosInGallery( [firstNode, secondNode] );
    await groupPhotosIntoObservation( firstNode, secondNode );

    const obsGridItems = await waitForMyObsGridItems();
    expect( obsGridItems[0] ).toBeVisible();
  } );

  it( "should not offer the photos of an import that is still saving", async ( ) => {
    const importedNode = makeMockNode( "still_saving_import", 1234567890 );
    const otherNode = makeMockNode( "still_saving_other", 1234567891 );
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [importedNode, otherNode] ),
    );
    global.mockSaveObservationsDelayMs = 3000;
    try {
      renderApp( );
      await navigateToPhotoImporterFromMyObs();
      await selectPhotosInGallery( [importedNode] );

      await waitFor( ( ) => {
        expect( screen.getByTestId( "GroupPhotos.list" ) ).toBeVisible( );
      }, { timeout: 10_000 } );
      const importButton = await screen.findByText( /IMPORT 1 OBSERVATION/ );
      await actor.press( importButton );

      // The import sends the user back to My Obs and keeps saving in the
      // background, so this is a second import started while the first is
      // still going.
      await waitForMyObservationsScreen( );
      await navigateToPhotoImporterFromMyObs();
      await waitFor( ( ) => {
        expect( screen.getByTestId( `PhotoGallery.${otherNode.image.uri}` ) ).toBeTruthy( );
      }, { timeout: 10_000 } );
      expect( screen.queryByTestId( `PhotoGallery.${importedNode.image.uri}` ) ).toBeNull( );
    } finally {
      global.mockSaveObservationsDelayMs = 0;
    }
  } );

  it( "should hide a photo that gets saved while the picker is open", async ( ) => {
    const savedNode = makeMockNode( "saved_while_open", 1234567890 );
    const keptNode = makeMockNode( "not_saved_while_open", 1234567891 );
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [savedNode, keptNode] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await waitFor( ( ) => {
      expect( screen.getByTestId( `PhotoGallery.${savedNode.image.uri}` ) ).toBeTruthy( );
    }, { timeout: 10_000 } );

    // As an import saving in the background or an upload finishing would.
    const realm = global.mockRealms[__filename];
    recordUploadedDevicePhotoUris( realm, [`ph://${savedNode.id}`] );

    await waitFor( ( ) => {
      expect( screen.queryByTestId( `PhotoGallery.${savedNode.image.uri}` ) ).toBeNull( );
    }, { timeout: 10_000 } );
    expect( screen.getByTestId( `PhotoGallery.${keptNode.image.uri}` ) ).toBeTruthy( );
  } );

  it( "should hide photos marked as saved without importing them", async ( ) => {
    const savedNode = makeMockNode( "marked_as_saved", 1234567890 );
    const keptNode = makeMockNode( "not_marked_as_saved", 1234567891 );
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue(
      makeGetPhotosResult( [savedNode, keptNode] ),
    );
    renderApp( );
    await navigateToPhotoImporterFromMyObs();
    await waitFor( ( ) => {
      expect( screen.getByTestId( `PhotoGallery.${savedNode.image.uri}` ) ).toBeTruthy( );
    }, { timeout: 10_000 } );
    fireEvent.press( screen.getByTestId( `PhotoGallery.${savedNode.image.uri}` ) );
    fireEvent.press( screen.getByTestId( "PhotoGallery.markAsSaved" ) );

    await waitFor( ( ) => {
      expect( screen.queryByTestId( `PhotoGallery.${savedNode.image.uri}` ) ).toBeNull( );
    } );
    expect( screen.getByTestId( `PhotoGallery.${keptNode.image.uri}` ) ).toBeTruthy( );
  } );
} );
