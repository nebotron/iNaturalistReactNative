import { format } from "date-fns";
import type { ExploreV2SearchWithTab, ExploreV2Subject } from "providers/ExploreV2Context";
import type { StateCreator } from "zustand";

export const subjectKey = ( subject: ExploreV2Subject ): string => {
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

export interface ExploreV2SearchesSlice {
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

const createExploreV2SearchesSlice: StateCreator<ExploreV2SearchesSlice> = set => ( {
  exploreSavedSearches: {
    searches: [],
    saveSearch: search => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: [
          { ...search, savedAt: Date.now( ), datesAsOf: today( ) },
          ...state.exploreSavedSearches.searches,
        ],
      },
    } ) ),
    updateSearch: ( key, search ) => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: state.exploreSavedSearches.searches.map( saved => ( saved.key === key
          ? {
            ...saved, ...search, key, datesAsOf: today( ),
          }
          : saved ) ),
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

export default createExploreV2SearchesSlice;
