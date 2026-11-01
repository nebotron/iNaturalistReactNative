import {
  act,
  screen,
  userEvent,
  within,
} from "@testing-library/react-native";
import inatjs from "inaturalistjs";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";

const actor = userEvent.setup( );

/** Turns on ExploreV2. Search state needs no clearing here: jest.post-setup resets every
 * store after each test. */
export const enableExploreV2 = ( ) => act( ( ) => {
  useStore.setState( state => ( {
    featureFlagConfig: {
      ...state.featureFlagConfig,
      exploreV2Enabled: true,
    },
  } ) );
} );

export async function navigateToExplore( ) {
  const tabBar = await screen.findByTestId( "CustomTabBar" );
  await actor.press( await within( tabBar ).findByText( "Explore" ) );
  await screen.findByTestId( "ExploreResults" );
}

export async function openAdvancedSearch( ) {
  const header = await screen.findByTestId( "ExploreV2Header" );
  await actor.press( within( header ).getByTestId( "ExploreV2Header.searchButton" ) );
  await screen.findByTestId( "AdvancedSearch" );
}

/** Clears the search Advanced Search reopened with, i.e. the search currently applied. */
export async function resetAdvancedSearch( ) {
  await actor.press( screen.getByTestId( "AdvancedSearch.back.reset" ) );
}

export async function submitAdvancedSearch( ) {
  await actor.press( screen.getByTestId( "AdvancedSearch.searchButton" ) );
  await screen.findByTestId( "ExploreResults" );
}

/** Adds a taxon to the open Advanced Search's taxon filters. Taxon search reads the local
 * species database, so the taxon is written to the given realm first. */
export async function addTaxonFilter( taxon, realm ) {
  safeRealmWrite( realm, ( ) => {
    realm.create( "Taxon", {
      id: taxon.id,
      name: taxon.name,
      preferred_common_name: taxon.preferred_common_name,
      rank: taxon.rank,
      rank_level: taxon.rank_level,
    }, "modified" );
  }, "writing a searchable taxon for an Explore integration test" );
  const addButton = screen.queryByText( "ADD TAXON FILTER" )
    || screen.getByText( "SEARCH FOR A TAXON" );
  await actor.press( addButton );
  await actor.type( await screen.findByLabelText( "Search for a taxon" ), taxon.name );
  act( ( ) => {
    jest.advanceTimersByTime( 400 );
  } );
  await actor.press( await screen.findByTestId( `Search.taxa.${taxon.id}` ) );
}

/** Searches for a taxon from Advanced Search. */
export async function searchForTaxon( taxon, realm ) {
  await openAdvancedSearch( );
  await resetAdvancedSearch( );
  await addTaxonFilter( taxon, realm );
  await submitAdvancedSearch( );
}

/** The params of the most recent observations search, i.e. what the user's choices produced. */
export function lastObservationsSearchParams( ) {
  const { calls } = inatjs.observations.search.mock;
  return calls[calls.length - 1]?.[0];
}
