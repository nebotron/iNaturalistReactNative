import "tests/helpers/mockMortalForIntegration";

import {
  screen,
  userEvent,
  waitFor,
} from "@testing-library/react-native";
import inatjs from "inaturalistjs";
import Observation from "realmModels/Observation";
import useStore from "stores/useStore";
import factory, { makeResponse } from "tests/factory";
import { renderAppWithComponent } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

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

const mockUser = factory( "LocalUser" );
const searchTaxon = factory( "RemoteTaxon", { name: "Searchus taxonus", rank_level: 10 } );

const makeObservation = ( ) => factory( "RemoteObservation", {
  _synced_at: null,
  needsSync: jest.fn( ( ) => true ),
  wasSynced: jest.fn( ( ) => false ),
  observationPhotos: [factory( "RemoteObservationPhoto" )],
  user: mockUser,
  observed_on_string: "2020-01-01",
  taxon: null,
} );

const actor = userEvent.setup( );

beforeAll( ( ) => {
  jest.useFakeTimers( );
} );

beforeEach( async ( ) => {
  await signIn( mockUser, { realm: global.mockRealms[__filename] } );
  setStoreStateLayout( { isDefaultMode: false, isAllAddObsOptionsMode: true } );
  inatjs.taxa.search.mockResolvedValue( makeResponse( [searchTaxon] ) );
  inatjs.computervision.score_image.mockResolvedValue( makeResponse( [] ) );
} );

afterEach( ( ) => {
  signOut( { realm: global.mockRealms[__filename] } );
} );

it( "advances to the next observation after choosing a taxon from search", async ( ) => {
  const observations = [makeObservation( ), makeObservation( ), makeObservation( )];
  await Promise.all( observations.map( obs => Observation.saveLocalObservationForUpload(
    obs,
    global.mockRealms[__filename],
  ) ) );
  renderAppWithComponent( );
  await actor.press( await screen.findByTestId( "BulkIDButton" ) );
  await actor.press( await screen.findByLabelText( "Search" ) );
  const input = await screen.findByTestId( "SearchTaxon" );
  await actor.type( input, "Searchus" );
  await waitFor( ( ) => expect( inatjs.taxa.search ).toHaveBeenCalled( ) );
  await waitFor( ( ) => expect( screen.queryByTestId( "SearchTaxon" ) ).toBeVisible( ) );
  await screen.findByTestId( `Search.taxa.${searchTaxon.id}` );
  await actor.press( await screen.findByTestId( `Search.taxa.${searchTaxon.id}` ) );
  await waitFor( ( ) => {
    expect( useStore.getState( ).observations.length ).toBe( 2 );
  } );
  await waitFor( ( ) => {
    expect( screen.queryByTestId( "SearchTaxon" ) ).toBeNull( );
  } );
  await waitFor( ( ) => {
    expect( screen.getByText( "SKIP (LEAVE UNKNOWN)" ) ).toBeVisible( );
  } );
  expect( useStore.getState( ).bulkUploadMode ).toBe( true );

  // Pick the now-recent taxon for the next observation without typing
  await actor.press( await screen.findByLabelText( "Search" ) );
  await actor.press( await screen.findByTestId( `Search.taxa.${searchTaxon.id}` ) );
  await waitFor( ( ) => {
    expect( useStore.getState( ).observations.length ).toBe( 1 );
  } );
  await waitFor( ( ) => {
    expect( screen.getByText( "SKIP (LEAVE UNKNOWN)" ) ).toBeVisible( );
  } );
} );
