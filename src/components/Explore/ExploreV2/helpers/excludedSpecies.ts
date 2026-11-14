import { fetchSpeciesCounts } from "api/observations";
import type { ApiTaxon } from "api/types";
import { syncResearchGradeSpeciesIds } from "components/Explore/helpers/withoutObservedSpecies";
import type { ExploreV2Search } from "providers/ExploreV2Context";
import { EXPLORE_V2_PLACE_MODE } from "providers/ExploreV2Context";
import { speciesIdFromTaxon } from "sharedHelpers/userObservationsCache";
import type { SavedSearch } from "stores/createExploreV2SearchesSlice";
import { findSavedSearchByName } from "stores/createExploreV2SearchesSlice";

import type { NearbyCoords } from "./buildQueryParams";
import buildExploreV2QueryParams, { excludesSpecies, unobservedByUserId } from "./buildQueryParams";
import relativeSavedSearch from "./relativeSavedSearch";

// A search can leave out two lists of species, which are combined:
//  - "Unobserved by me": species the user has a research-grade observation of,
//    from their synced observation history (see withoutObservedSpecies)
//  - "Exclude species in a saved search": the species the named saved search
//    finds, fetched from species_counts. The saved search is looked up by name
//    each time, so editing it changes every search that excludes it. It can
//    itself exclude species, so it's resolved recursively.

type SearchToResolve = Pick<ExploreV2Search, "subject" | "filters">;

// Why a saved search's species can't be excluded:
//  - missing: no saved search has the name, e.g. it was renamed or deleted
//  - cycle: saved searches exclude each other's species, so none can be resolved
//  - offline: species_counts can't be fetched offline, and there's no stored copy
export class ExcludedSavedSearchError extends Error {
  reason: "missing" | "cycle" | "offline";

  savedSearchName: string;

  constructor( reason: ExcludedSavedSearchError["reason"], savedSearchName: string ) {
    super( `Can't exclude species in saved search "${savedSearchName}": ${reason}` );
    this.name = "ExcludedSavedSearchError";
    this.reason = reason;
    this.savedSearchName = savedSearchName;
  }
}

export interface ExcludedSpeciesContext {
  savedSearches: SavedSearch[];
  apiToken: string | null;
  // The signed-in user, for the reviewed filter of a referenced saved search
  currentUserId?: number | null;
  offline?: boolean;
  // Where Nearby is, for a referenced saved search that searches nearby
  getNearbyCoords: ( ) => Promise<NearbyCoords | undefined>;
}

// Max species_counts page size
const SPECIES_PAGE_SIZE = 500;
// The API won't page past 10,000 results
const MAX_SPECIES_PAGES = 20;

const SPECIES_FIELDS = {
  taxon: {
    id: true,
    rank_level: true,
    ancestor_ids: true,
  },
};

interface SpeciesCountsPage {
  total_results?: number;
  results?: { taxon?: ApiTaxon }[];
}

// The saved searches an exclusion chain names, in order, stopping at a missing
// or repeated one. Lets callers notice when any of them is edited.
export const referencedSavedSearches = (
  search: SearchToResolve,
  savedSearches: SavedSearch[],
): SavedSearch[] => {
  const chain: SavedSearch[] = [];
  let name = search.filters.excludeSpeciesInSavedSearch;
  while ( name ) {
    const saved = findSavedSearchByName( savedSearches, name );
    if ( !saved || chain.includes( saved ) ) break;
    chain.push( saved );
    name = saved.filters.excludeSpeciesInSavedSearch;
  }
  return chain;
};

const fetchSpeciesIds = async (
  params: Record<string, unknown>,
  apiToken: string | null,
): Promise<number[]> => {
  const ids = new Set<number>( );
  for ( let page = 1; page <= MAX_SPECIES_PAGES; page += 1 ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetchSpeciesCounts<SpeciesCountsPage>( {
      ...params,
      page,
      per_page: SPECIES_PAGE_SIZE,
      fields: SPECIES_FIELDS,
    }, { api_token: apiToken } ) as SpeciesCountsPage | null;
    const results = response?.results;
    if ( !Array.isArray( results ) ) {
      throw new Error( "Unreadable species_counts response" );
    }
    results.forEach( ( { taxon } ) => {
      // An observation identified below species level is still an observation
      // of the species, as with "Unobserved by me"
      const speciesId = speciesIdFromTaxon( taxon );
      if ( speciesId ) ids.add( speciesId );
    } );
    const total = response?.total_results ?? 0;
    if ( results.length < SPECIES_PAGE_SIZE || page * SPECIES_PAGE_SIZE >= total ) break;
  }
  return Array.from( ids );
};

const savedSearchSpeciesIds = async (
  name: string,
  context: ExcludedSpeciesContext,
  // Keys of the saved searches being resolved further up the chain
  resolving: string[],
): Promise<number[]> => {
  const saved = findSavedSearchByName( context.savedSearches, name );
  if ( !saved ) throw new ExcludedSavedSearchError( "missing", name );
  if ( resolving.includes( saved.key ) ) throw new ExcludedSavedSearchError( "cycle", name );
  if ( context.offline ) throw new ExcludedSavedSearchError( "offline", name );

  const search = relativeSavedSearch( saved );
  // eslint-disable-next-line no-use-before-define
  const nestedIds = await resolveExcludedSpeciesIds( search, context, [...resolving, saved.key] );
  const nearbyCoords = search.location.placeMode === EXPLORE_V2_PLACE_MODE.NEARBY
    ? await context.getNearbyCoords( )
    : undefined;
  if ( search.location.placeMode === EXPLORE_V2_PLACE_MODE.NEARBY && !nearbyCoords ) {
    // Without coordinates the search would quietly turn worldwide
    throw new Error( `No location for nearby saved search "${name}"` );
  }
  const {
    per_page: _perPage, order: _order, order_by: _orderBy, ...params
  } = buildExploreV2QueryParams( search, nearbyCoords, context.currentUserId, nestedIds );
  return fetchSpeciesIds( { ...params }, context.apiToken );
};

// Every species the search leaves out. Empty when it leaves none out. Throws
// (e.g. ExcludedSavedSearchError) rather than dropping an exclusion it can't
// resolve.
export const resolveExcludedSpeciesIds = async (
  search: SearchToResolve,
  context: ExcludedSpeciesContext,
  resolving: string[] = [],
): Promise<number[]> => {
  if ( !excludesSpecies( search ) ) return [];
  const ids = new Set<number>( );
  const userId = unobservedByUserId( search );
  if ( userId ) {
    const observed = await syncResearchGradeSpeciesIds(
      userId,
      { api_token: context.apiToken },
      { offline: context.offline },
    );
    observed.forEach( id => ids.add( id ) );
  }
  const name = search.filters.excludeSpeciesInSavedSearch;
  if ( name ) {
    const found = await savedSearchSpeciesIds( name, context, resolving );
    found.forEach( id => ids.add( id ) );
  }
  return Array.from( ids );
};
