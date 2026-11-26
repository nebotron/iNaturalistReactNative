import { format } from "date-fns";
import type { ExploreSubject, ExploreV2SearchWithTab } from "providers/ExploreContext";
import type { StateCreator } from "zustand";

export const subjectKey = ( subject: ExploreSubject ): string => {
  switch ( subject.type ) {
    case "taxon":
      return `taxon-${subject.taxon.id}`;
    case "user":
      return `user-${subject.user.id}`;
    case "project":
      return `project-${subject.project.id}`;
    case "unobserved":
      return `unobserved-${subject.user.id}`;
    case "unknown":
      return "unknown";
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
};

// A named search plus a unique id and when it was saved. Searches saved before names
// existed have no name. datesAsOf is the local day (yyyy-MM-dd) its date filters were
// chosen on, so they can move forward with the calendar; searches saved before it existed
// fall back to savedAt.
export type SavedSearch = {
  key: string;
  name?: string;
  savedAt: number;
  datesAsOf?: string;
} & ExploreV2SearchWithTab;

// What a caller hands us. The key comes from savedSearchKey in the Explore helpers, which
// imports subjectKey from here. computing it in the slice would be circular.
export type SavedSearchInput = Omit<SavedSearch, "savedAt" | "datesAsOf">;

// Saved search names are unique ignoring case and surrounding space
const normalizedName = ( name: string ) => name.trim( ).toLowerCase( );

export const findSavedSearchByName = (
  searches: SavedSearch[],
  name: string,
): SavedSearch | undefined => searches.find(
  search => !!search.name && normalizedName( search.name ) === normalizedName( name ),
);

const today = ( ) => format( new Date( ), "yyyy-MM-dd" );

// A saved search can't leave out its own species. Overwriting one with a search that
// excludes it, e.g. from a search that excludes the one being overwritten, would leave every
// search that excludes it failing on the loop, so the exclusion that leads back is dropped.
const withoutExclusionLoop = ( searches: SavedSearch[], key: string ): SavedSearch[] => {
  const saved = searches.find( search => search.key === key );
  const visited: SavedSearch[] = [];
  let name = saved?.filters.excludeSpeciesInSavedSearch;
  while ( name ) {
    const next = findSavedSearchByName( searches, name );
    if ( !next || visited.includes( next ) ) return searches;
    if ( next.key === key ) {
      return searches.map( search => ( search.key === key
        ? { ...search, filters: { ...search.filters, excludeSpeciesInSavedSearch: null } }
        : search ) );
    }
    visited.push( next );
    name = next.filters.excludeSpeciesInSavedSearch;
  }
  return searches;
};

export interface ExploreSearchesSlice {
  exploreSavedSearches: {
    searches: SavedSearch[];
    saveSearch: ( _search: SavedSearchInput ) => void;
    updateSearch: ( _key: string, _search: ExploreV2SearchWithTab ) => void;
    removeSearch: ( _key: string ) => void;
    clearSavedSearches: ( ) => void;
    // Users who've been given the starter saved searches, so each gets them once
    defaultsAddedForUserIds: number[];
    addDefaultSearches: ( _userId: number, _searches: SavedSearchInput[] ) => void;
  };
  // The Explore tab's most recent search, restored when the app relaunches
  lastExploreSearch: ExploreV2SearchWithTab | null;
  setLastExploreSearch: ( _search: ExploreV2SearchWithTab ) => void;
}

const createExploreSearchesSlice: StateCreator<ExploreSearchesSlice> = set => ( {
  exploreSavedSearches: {
    searches: [],
    saveSearch: search => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: withoutExclusionLoop( [
          { ...search, savedAt: Date.now( ), datesAsOf: today( ) },
          ...state.exploreSavedSearches.searches,
        ], search.key ),
      },
    } ) ),
    updateSearch: ( key, search ) => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: withoutExclusionLoop(
          state.exploreSavedSearches.searches.map( saved => ( saved.key === key
            ? {
              ...saved, ...search, key, datesAsOf: today( ),
            }
            : saved ) ),
          key,
        ),
      },
    } ) ),
    removeSearch: key => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: state.exploreSavedSearches.searches.filter( saved => saved.key !== key ),
      },
    } ) ),
    clearSavedSearches: ( ) => set( state => ( {
      exploreSavedSearches: { ...state.exploreSavedSearches, searches: [] },
    } ) ),
    defaultsAddedForUserIds: [],
    // Adds the starter searches after any already saved, skipping one whose name is taken
    addDefaultSearches: ( userId, defaults ) => set( state => {
      const { searches, defaultsAddedForUserIds } = state.exploreSavedSearches;
      if ( defaultsAddedForUserIds.includes( userId ) ) return state;
      const added = defaults
        .filter( search => !search.name || !findSavedSearchByName( searches, search.name ) )
        .map( search => ( { ...search, savedAt: Date.now( ), datesAsOf: today( ) } ) );
      return {
        exploreSavedSearches: {
          ...state.exploreSavedSearches,
          searches: [...searches, ...added],
          defaultsAddedForUserIds: [...defaultsAddedForUserIds, userId],
        },
      };
    } ),
  },
  lastExploreSearch: null,
  setLastExploreSearch: lastExploreSearch => set( { lastExploreSearch } ),
} );

export default createExploreSearchesSlice;
