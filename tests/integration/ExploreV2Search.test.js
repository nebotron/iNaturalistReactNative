import {
  screen,
  userEvent,
  waitFor,
  within,
} from "@testing-library/react-native";
import initI18next from "i18n/initI18next";
import inatjs from "inaturalistjs";
import isEqual from "lodash/isEqual";
import { defaultExploreV2Filters } from "providers/ExploreV2Context";
import useStore from "stores/useStore";
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
import {
  savedSearch, setSavedSearches, skipDefaultSavedSearches,
} from "tests/helpers/savedSearch";
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
  skipDefaultSavedSearches( mockUser.id );
  await signIn( mockUser, { realm: global.mockRealms[__filename] } );
} );

afterEach( async ( ) => {
  await signOut( { realm: global.mockRealms[__filename] } );
} );

global.withAnimatedTimeTravelEnabled( { skipFakeTimers: true } );

describe( "searching from Advanced Search", ( ) => {
  describe( "excluding the species in a saved search", ( ) => {
    // The species fetch asks for just enough to find each taxon's species
    const isSpeciesFetch = params => isEqual( params?.fields, {
      taxon: { id: true, rank_level: true, ancestor_ids: true },
    } );

    beforeEach( ( ) => {
      inatjs.observations.speciesCounts.mockClear( );
      setSavedSearches( [{
        ...savedSearch( { subject: { type: "taxon", taxon: { id: 47126, name: "Plantae" } } } ),
        key: "saved-backyard",
        name: "Backyard",
      }] );
    } );

    afterEach( ( ) => setSavedSearches( [] ) );

    it( "leaves out the saved search's species, and fails clearly once renamed", async ( ) => {
      renderApp( );
      await navigateToExplore( );
      await openAdvancedSearch( );

      await actor.press( screen.getByLabelText( "Exclude species in a saved search" ) );
      // The saved search list shows it too; the sheet comes last
      await actor.press( ( await screen.findAllByText( "Backyard" ) ).at( -1 ) );
      await actor.press( screen.getByText( "CONFIRM" ) );
      expect( await screen.findByText( "Excluding species in “Backyard”" ) ).toBeVisible( );
      await submitAdvancedSearch( );

      await waitFor( ( ) => {
        expect( lastObservationsSearchParams( ) ).toMatchObject( {
          without_taxon_id: String( mockTaxon.id ),
        } );
      } );
      const speciesFetch = inatjs.observations.speciesCounts.mock.calls
        .map( call => call[0] )
        .find( isSpeciesFetch );
      expect( speciesFetch ).toMatchObject( { taxon_id: 47126 } );

      setSavedSearches( [{
        ...useStore.getState( ).exploreSavedSearches.searches[0],
        name: "Back yard",
      }] );

      expect( await screen.findByTestId( "ExploreResults.excludedSpeciesError" ) ).toBeVisible( );
      expect( screen.getByText( /there’s no saved search with that name/ ) ).toBeVisible( );
    } );
  } );

  it( "still excludes a saved search overwritten from a search that excludes it", async ( ) => {
    setSavedSearches( [
      {
        ...savedSearch( { subject: { type: "taxon", taxon: { id: 47126, name: "Plantae" } } } ),
        key: "saved-backyard",
        name: "Backyard",
      },
      {
        ...savedSearch( {
          subject: null,
          filters: { ...defaultExploreV2Filters, excludeSpeciesInSavedSearch: "Backyard" },
        } ),
        key: "saved-not-backyard",
        name: "Not in backyard",
      },
    ] );
    renderApp( );
    await navigateToExplore( );
    await openAdvancedSearch( );
    await actor.press( screen.getByTestId( "SavedSearches.load.saved-not-backyard" ) );
    await screen.findByTestId( "ExploreResults" );

    // Edit Backyard from the search that excludes it
    await openAdvancedSearch( );
    await addTaxonFilter( mockOtherTaxon, global.mockRealms[__filename] );
    inatjs.observations.speciesCounts.mockClear( );
    await actor.press( screen.getByTestId( "SavedSearches.overwrite.saved-backyard" ) );
    await actor.press( screen.getByTestId( "SavedSearches.load.saved-not-backyard" ) );
    await screen.findByTestId( "ExploreResults" );

    await waitFor( ( ) => {
      const speciesFetches = inatjs.observations.speciesCounts.mock.calls
        .map( call => call[0] )
        .filter( params => isEqual( params?.fields, {
          taxon: { id: true, rank_level: true, ancestor_ids: true },
        } ) );
      expect( speciesFetches.at( -1 ) ).toMatchObject( { taxon_id: mockOtherTaxon.id } );
    } );
    expect( screen.queryByTestId( "ExploreResults.excludedSpeciesError" ) ).toBeNull( );
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

    await actor.press( within( await screen.findByTestId( "CustomTabBar" ) )
      .getByTestId( "NavButton.personIcon" ) );
    // The Me tab resets its stack, which renders the tab bar afresh
    await actor.press( within( await screen.findByTestId( "CustomTabBar" ) )
      .getByText( "Explore" ) );

    await screen.findByTestId( "ExploreResults" );
    const header = await screen.findByTestId( "ExploreV2Header" );
    expect( within( header ).getByText( mockTaxon.name ) ).toBeVisible( );
  } );
} );
