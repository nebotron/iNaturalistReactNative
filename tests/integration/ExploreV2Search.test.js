import {
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import inatjs from "inaturalistjs";
import factory, { makeResponse } from "tests/factory";
import {
  addTaxonFilter,
  enableExploreV2,
  lastObservationsSearchParams,
  navigateToExplore,
  openAdvancedSearch,
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

const mockOtherTaxon = factory( "RemoteTaxon", {
  id: 746,
  name: "Silphium laciniatum",
  preferred_common_name: "Compass Plant",
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

beforeAll( async ( ) => {
  await initI18next( );
  jest.useFakeTimers( );
  inatjs.observations.search.mockResolvedValue( makeResponse( mockObservations ) );
  inatjs.observations.speciesCounts.mockResolvedValue( makeResponse( [{
    count: 1,
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

describe( "searching from Advanced Search", ( ) => {
  it( "searches for species the signed-in user has not observed", async ( ) => {
    renderApp( );
    await navigateToExplore( );
    await openAdvancedSearch( );

    await actor.press( screen.getByText( "Unobserved by me" ) );
    await submitAdvancedSearch( );

    await waitFor( ( ) => {
      expect( lastObservationsSearchParams( ) ).toMatchObject( {
        unobserved_by_user_id: mockUser.id,
      } );
    } );
    const header = await screen.findByTestId( "ExploreV2Header" );
    expect( within( header ).getByTestId( "ExploreV2Header.unobserved" ) ).toBeVisible( );
  } );

  it( "searches for several taxa at once", async ( ) => {
    renderApp( );
    await navigateToExplore( );
    await openAdvancedSearch( );

    await addTaxonFilter( mockTaxon, global.mockRealms[__filename] );
    await addTaxonFilter( mockOtherTaxon, global.mockRealms[__filename] );
    await submitAdvancedSearch( );

    await waitFor( ( ) => {
      expect( lastObservationsSearchParams( ) ).toMatchObject( {
        taxon_id: `${mockTaxon.id},${mockOtherTaxon.id}`,
      } );
    } );
    const header = await screen.findByTestId( "ExploreV2Header" );
    expect( within( header ).getByText( mockTaxon.name ) ).toBeVisible( );
  } );

  it( "still has the search when the user comes back from another tab", async ( ) => {
    renderApp( );
    await navigateToExplore( );
    await searchForTaxon( mockTaxon, global.mockRealms[__filename] );
    await waitFor( ( ) => {
      expect( lastObservationsSearchParams( ) ).toMatchObject( { taxon_id: mockTaxon.id } );
    } );

    const tabBar = await screen.findByTestId( "CustomTabBar" );
    await actor.press( within( tabBar ).getByTestId( "NavButton.personIcon" ) );
    await actor.press( within( tabBar ).getByText( "Explore" ) );

    await screen.findByTestId( "ExploreResults" );
    const header = await screen.findByTestId( "ExploreV2Header" );
    expect( within( header ).getByText( mockTaxon.name ) ).toBeVisible( );
  } );
} );
