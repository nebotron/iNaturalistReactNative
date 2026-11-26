import {
  act,
  screen,
  userEvent,
  within,
} from "@testing-library/react-native";
import inatjs from "inaturalistjs";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const actor = userEvent.setup( );

export async function navigateToExplore( ) {
  const tabBar = await screen.findByTestId( "CustomTabBar" );
  await actor.press( await within( tabBar ).findByText( "Explore" ) );
  await screen.findByTestId( "ExploreResults" );
}

export async function openAdvancedSearch( ) {
  const header = await screen.findByTestId( "ExploreHeader" );
  await actor.press( within( header ).getByTestId( "ExploreHeader.searchButton" ) );
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

/** The params of the most recent Explore observations search, i.e. what the user's choices
 * produced. Searches from lists in other tabs, like My Observations paging in the background,
 * are skipped: only Explore asks for the bounds of its results. The params are copied without
 * the query's own context (its client, signal and so on), which only gets in the way of
 * comparing them. */
export function lastObservationsSearchParams( ) {
  const { calls } = inatjs.observations.search.mock;
  const params = calls.map( call => call[0] ).filter( p => p?.return_bounds ).at( -1 );
  if ( !params ) return params;
  const {
    client, queryKey, pageParam, direction, meta, signal, ...searchParams
  } = params;
  return searchParams;
}
