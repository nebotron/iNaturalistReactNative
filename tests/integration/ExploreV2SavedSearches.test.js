import {
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import i18next from "i18next";
import inatjs from "inaturalistjs";
import factory, { makeResponse } from "tests/factory";
import {
  enableExploreV2,
  lastObservationsSearchParams,
  navigateToExplore,
  openAdvancedSearch,
  resetAdvancedSearch,
  searchForTaxon,
  submitAdvancedSearch,
} from "tests/helpers/exploreV2";
import faker from "tests/helpers/faker";
import { renderApp } from "tests/helpers/render";
import setStoreStateLayout from "tests/helpers/setStoreStateLayout";
import setupUniqueRealm from "tests/helpers/uniqueRealm";
import { signIn, signOut } from "tests/helpers/user";

jest.unmock( "@react-navigation/native" );

const mockUser = factory( "LocalUser", {
  login: faker.internet.username( ),
  locale: "en",
} );

const mockTaxon = factory( "RemoteTaxon", {
  id: 745,
  name: "Silphium perfoliatum",
  preferred_common_name: "Cup Plant",
  rank: "species",
  rank_level: 10,
} );

const mockObservations = [factory( "RemoteObservation", { taxon: mockTaxon } )];

jest.mock( "sharedHelpers/fetchCoarseUserLocation", ( ) => ( {
  __esModule: true,
  default: ( ) => Promise.resolve( { latitude: 37, longitude: 34 } ),
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

const actor = userEvent.setup( );

const t = key => i18next.t( key );

beforeAll( async ( ) => {
  await initI18next( );
  jest.useFakeTimers( );
  inatjs.observations.search.mockResolvedValue( makeResponse( mockObservations ) );
  inatjs.observations.speciesCounts.mockResolvedValue( makeResponse( [{
    count: 1,
    taxon: mockTaxon,
  }] ) );
  inatjs.search.mockResolvedValue( makeResponse( [{
    type: "taxon",
    score: 1,
    taxon: mockTaxon,
  }] ) );
} );

beforeEach( async ( ) => {
  setStoreStateLayout( { isDefaultMode: false, isAllAddObsOptionsMode: true } );
  enableExploreV2( );
  inatjs.observations.search.mockClear( );
  await signIn( mockUser, { realm: global.mockRealms[__filename] } );
} );

afterEach( async ( ) => {
  await signOut( { realm: global.mockRealms[__filename] } );
} );

global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

describe( "saved searches", ( ) => {
  it( "saves a named search, runs it again later, and deletes it", async ( ) => {
    renderApp( );
    await navigateToExplore( );
    await searchForTaxon( mockTaxon, global.mockRealms[__filename] );

    await openAdvancedSearch( );
    expect( await screen.findByText( t( "No-saved-filters-yet" ) ) ).toBeVisible( );
    await actor.press( screen.getByTestId( "SavedSearches.save" ) );
    await actor.type( await screen.findByTestId( "TextInputSheet.notes" ), "Cup plants" );
    await actor.press( screen.getByTestId( "TextInputSheet.confirm" ) );
    expect( await screen.findByText( "Cup plants" ) ).toBeVisible( );

    // Clear the subject, so the search goes back to all organisms worldwide and applying
    // the saved search has something to change
    await resetAdvancedSearch( );
    await submitAdvancedSearch( );
    await waitFor( ( ) => {
      expect( lastObservationsSearchParams( ) ).not.toHaveProperty( "taxon_id" );
    } );

    await openAdvancedSearch( );
    const savedList = await screen.findByTestId( "SavedSearches" );
    await actor.press( within( savedList ).getByText( "Cup plants" ) );

    await screen.findByTestId( "ExploreResults" );
    await waitFor( ( ) => {
      expect( lastObservationsSearchParams( ) ).toMatchObject( { taxon_id: mockTaxon.id } );
    } );
    expect( screen.queryByLabelText( "Save this search" ) ).toBeNull( );

    await openAdvancedSearch( );
    await actor.press( within( await screen.findByTestId( "SavedSearches" ) )
      .getByLabelText( t( "Delete-saved-filter" ) ) );
    await actor.press( await screen.findByText( t( "DELETE" ) ) );
    expect( await screen.findByText( t( "No-saved-filters-yet" ) ) ).toBeVisible( );
  } );
} );
