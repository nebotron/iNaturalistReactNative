import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import {
  fireEvent,
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import inatjs from "inaturalistjs";
import { SCREEN_AFTER_PHOTO_EVIDENCE } from "stores/createLayoutSlice";
import factory, { makeResponse } from "tests/factory";
import {
  mockInteractionManagerRunAfterInteractions,
  navigateToPhotoImporterFromMyObs,
  waitForMyObsGridItems,
} from "tests/helpers/addObsBottomSheet";
import faker from "tests/helpers/faker";
import { renderApp } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";

// We're explicitly testing navigation here so we want react-navigation
// working normally
jest.unmock( "@react-navigation/native" );

const mockUser = factory( "LocalUser" );
// Mock useCurrentUser hook
jest.mock( "sharedHooks/useCurrentUser", () => ( {
  __esModule: true,
  default: jest.fn( () => mockUser ),
} ) );

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

beforeAll( async () => {
  await initI18next();
  mockInteractionManagerRunAfterInteractions();
} );

// Mock the response from inatjs.computervision.score_image
const topSuggestion = {
  taxon: factory.states( "genus" )( "RemoteTaxon", { name: "Primum" } ),
  combined_score: 90,
};

describe( "Photo Deletion with existing saved observation", () => {
  global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

  const actor = userEvent.setup( );

  beforeEach( async () => {
    setStoreStateLayout( {
      isDefaultMode: false,
      isAllAddObsOptionsMode: true,
      screenAfterPhotoEvidence: SCREEN_AFTER_PHOTO_EVIDENCE.OBS_EDIT,
    } );
    inatjs.computervision.score_image.mockResolvedValue( makeResponse( [topSuggestion] ) );
  } );

  async function createSavedObservationWithImportedPhoto() {
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
    const obsGridItems = await waitForMyObsGridItems();
    await actor.press( obsGridItems[0] );
    await screen.findByText( "EVIDENCE" );
  }

  async function deletePhotoInMediaViewer() {
    const deleteButton = await screen.findByLabelText( "Delete photo" );
    await actor.press( deleteButton );
    const warningSheet = await screen.findByTestId( "MediaViewer.DiscardMediaWarningSheet" );
    const discardButton = await within( warningSheet ).findByText( "DISCARD" );
    await actor.press( discardButton );
  }

  async function expectNoPhotosInStandardCamera() {
    const noPhotoText = await screen.findByText( "Photos you take will appear here" );
    expect( noPhotoText ).toBeVisible();
  }

  async function viewPhotoFromObsEdit() {
    const evidenceItem = await screen.findByLabelText( "Select or drag media" );
    expect( evidenceItem ).toBeVisible();
    fireEvent.press( evidenceItem );
  }

  async function expectObsEditToHaveNoPhotos() {
    // Confirm there is no evidence
    expect( await screen.findByText( "EVIDENCE" ) ).toBeVisible();
    await waitFor( () => {
      const evidenceItems = screen.queryAllByLabelText( "Select or drag media" );
      expect( evidenceItems.length ).toEqual( 0 );
    } );
  }

  it( "should delete from StandardCamera for existing photo", async ( ) => {
    renderApp( );
    await createSavedObservationWithImportedPhoto();
    // Enter camera to add new photo
    const addEvidenceButton = await screen.findByLabelText( "Add evidence" );
    await actor.press( addEvidenceButton );
    const addEvidenceSheet = await screen.findByTestId( "AddEvidenceSheet" );
    const cameraButton = await within( addEvidenceSheet ).findByLabelText( "Camera" );
    await actor.press( cameraButton );
    await waitFor( () => {
      expect( screen.getByTestId( "CameraNavButtons" ) ).toBeVisible();
    } );
    // Tap the photo preview to enter the MediaViewer
    const carouselPhoto = await screen.findByTestId( /PhotoCarousel\.displayPhoto/ );
    fireEvent.press( carouselPhoto );
    await deletePhotoInMediaViewer();
    await expectNoPhotosInStandardCamera();
  } );

  it( "should delete from ObsEdit for existing camera photo", async ( ) => {
    renderApp( );
    await createSavedObservationWithImportedPhoto();
    await viewPhotoFromObsEdit();
    await deletePhotoInMediaViewer( );
    await expectObsEditToHaveNoPhotos();
  } );

  // TODO these will require mocking react-native-image-picker
  it.todo( "should delete from ObsEdit for existing gallery photo" );
} );
