import {
  fireEvent,
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import initI18next from "i18n/initI18next";
import inatjs from "inaturalistjs";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import { SCREEN_AFTER_PHOTO_EVIDENCE } from "stores/createLayoutSlice";
import factory, { makeResponse } from "tests/factory";
import {
  mockInteractionManagerRunAfterInteractions,
  navigateToPhotoImporterFromMyObs,
} from "tests/helpers/addObsBottomSheet";
import faker from "tests/helpers/faker";
import { renderApp } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

// We're explicitly testing navigation here so we want react-navigation
// working normally
jest.unmock( "@react-navigation/native" );

const mockUnsyncedObservations = [
  factory( "LocalObservation", {
    _synced_at: null,
    _created_at: faker.date.past( ),
    observed_on_string: "2024-05-01",
    latitude: 1.2345,
    longitude: 1.2345,
    taxon: factory( "LocalTaxon" ),
  } ),
  factory( "LocalObservation", {
    _synced_at: null,
    _created_at: faker.date.past( ),
    observed_on_string: "2024-05-02",
    latitude: 1.2345,
    longitude: 1.2345,
    taxon: factory( "LocalTaxon" ),
  } ),
  factory( "LocalObservation", {
    _synced_at: null,
    _created_at: faker.date.past( ),
    observed_on_string: "2024-05-03",
    latitude: 1.2345,
    longitude: 1.2345,
    taxon: factory( "LocalTaxon" ),
  } ),
];

const mockUser = factory( "LocalUser", {
  login: faker.internet.userName( ),
  iconUrl: faker.image.url( ),
  locale: "en",
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
  await initI18next( );
  mockInteractionManagerRunAfterInteractions( );
} );

// Mock the response from inatjs.computervision.score_image
const topSuggestion = {
  taxon: factory.states( "genus" )( "RemoteTaxon", { name: "Primum" } ),
  combined_score: 90,
};

const actor = userEvent.setup( );

beforeEach( ( ) => {
  setStoreStateLayout( {
    isDefaultMode: false,
    isAllAddObsOptionsMode: true,
    screenAfterPhotoEvidence: SCREEN_AFTER_PHOTO_EVIDENCE.OBS_EDIT,
  } );
  inatjs.computervision.score_image.mockResolvedValue( makeResponse( [topSuggestion] ) );
} );

const checkToolbarResetWithUnsyncedObs = ( ) => waitFor( ( ) => {
  const toolbarText = screen.getByText( /Upload 3 observations/ );
  expect( toolbarText ).toBeVisible();
} );

const writeObservationsToRealm = ( observations, message ) => {
  const realm = global.mockRealms[__filename];
  safeRealmWrite( realm, ( ) => {
    observations.forEach( mockObservation => {
      realm.create( "Observation", mockObservation );
    } );
  }, message );
};

const pressIndividualUpload = async observation => {
  const uploadIcon = screen.getByTestId(
    `UploadIcon.start.${observation.uuid}`,
  );
  expect( uploadIcon ).toBeVisible( );
  await actor.press( uploadIcon );
};

const waitForDisplayedText = async ( text, timeout = 1000 ) => {
  await waitFor( ( ) => {
    expect( screen.getByText( text ) ).toBeVisible( );
  }, { timeout } );
};

// const deleteObservationByTaxonName = async name => {
//   await pressButtonByText( name );
//   await waitForDisplayedText( /Edit Observation/ );
//   await pressButtonByLabel( /Menu/ );
//   await pressButtonByText( /Delete observation/ );
//   await pressButtonByText( "DELETE" );
//   await waitForDisplayedText( /1 observation deleted/ );
// };

describe( "MyObservations -> Photo Importer -> ObsEdit -> MyObservations", ( ) => {
  global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );
  // Mock inatjs endpoints so they return the right responses for the right test data
  inatjs.observations.create.mockImplementation( ( params, _opts ) => {
    const mockObs = mockUnsyncedObservations.find( o => o.uuid === params.observation.uuid );
    return Promise.resolve( makeResponse( [{ id: faker.number.int( ), uuid: mockObs.uuid }] ) );
  } );
  inatjs.observations.fetch.mockImplementation( ( uuid, _params, _opts ) => {
    const mockObs = mockUnsyncedObservations.find( o => o.uuid === uuid );
    // It would be a lot better if this returned something that looks like
    // a remote obs, but this works
    return Promise.resolve( makeResponse( [mockObs] ) );
  } );

  beforeEach( async ( ) => {
    await signIn( mockUser, { realm: global.mockRealms[__filename] } );
    writeObservationsToRealm(
      mockUnsyncedObservations,
      "writing observations for MyObservations navigation test",
    );
  } );

  afterEach( async ( ) => {
    await signOut( { realm: global.mockRealms[__filename] } );
  } );

  it( "should display fresh toolbar status after uploading an observation, then"
    + " navigating away and returning to MyObs", async ( ) => {
    renderApp( );
    await checkToolbarResetWithUnsyncedObs( );
    await pressIndividualUpload( mockUnsyncedObservations[0] );
    await waitForDisplayedText( /1 observation uploaded/ );
    const mockNode = {
      id: "MOCK-ID-1",
      type: "image",
      group_name: "Camera Roll",
      image: {
        filename: `${faker.string.uuid()}.jpg`,
        filepath: "/path/to/photo.jpg",
        extension: "jpg",
        uri: "file:///path/to/photo.jpg",
        height: 1920,
        width: 1080,
        fileSize: 123456,
        playableDuration: NaN,
        orientation: 1,
      },
      timestamp: 1234567890,
      location: null,
    };
    jest.spyOn( CameraRoll, "getPhotos" ).mockResolvedValue( {
      page_info: { end_cursor: undefined, has_next_page: false },
      edges: [{ node: mockNode }],
    } );
    await navigateToPhotoImporterFromMyObs();
    await waitFor( ( ) => {
      expect( screen.getByTestId( `PhotoGallery.${mockNode.image.uri}` ) ).toBeTruthy( );
    }, { timeout: 10_000 } );
    fireEvent.press( screen.getByTestId( `PhotoGallery.${mockNode.image.uri}` ) );
    fireEvent.press( screen.getByTestId( "PhotoGallery.done" ) );
    await waitFor( ( ) => {
      expect( screen.getByText( /Group Photos/ ) ).toBeVisible( );
    }, { timeout: 10_000 } );
    const importButton = await screen.findByText( /IMPORT 1 OBSERVATION/ );
    await actor.press( importButton );
    await waitForDisplayedText( /Upload 3 observations/, 10_000 );
  } );

  // it( "should display fresh toolbar status after deleting an observation, then"
  //   + " navigating away, deleting a second observation, and returning to MyObs", async ( ) => {
  //   renderApp( );
  //   await checkToolbarResetWithUnsyncedObs( );
  //   await deleteObservationByTaxonName( mockUnsyncedObservations[0].taxon.name );
  //   await deleteObservationByTaxonName( mockUnsyncedObservations[1].taxon.name );
  // } );

  // it.todo(
  //   "should display empty MyObs screen after all three observations are deleted",
  //   async ( ) => {
  //     renderApp( );
  //     await checkToolbarResetWithUnsyncedObs( );
  //     await deleteObservationByTaxonName( mockUnsyncedObservations[0].taxon.name );
  //     await deleteObservationByTaxonName( mockUnsyncedObservations[1].taxon.name );
  //     await deleteObservationByTaxonName( mockUnsyncedObservations[2].taxon.name );
  //     await waitForDisplayedText( /CREATE YOUR FIRST OBSERVATION/ );
  //   }
  // );
} );
