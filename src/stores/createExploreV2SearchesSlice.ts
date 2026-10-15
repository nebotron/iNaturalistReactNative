import type { ExploreV2Search, ExploreV2Subject, Place } from "providers/ExploreV2Context";
import type { StateCreator } from "zustand";

export const RECENT_LIMIT = 10;

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

export const placeKey = ( place: Place ): string => `place-${place.id}`;

// Newest first, unique by key, capped at 10. Recording something already in the list
// bumps it to the front instead of duplicating it.
export const addRecent = <T>(
  items: T[],
  item: T,
  keyFn: ( _item: T ) => string,
  cap: number = RECENT_LIMIT,
): T[] => [
    item,
    ...items.filter( existing => keyFn( existing ) !== keyFn( item ) ),
  ].slice( 0, cap );

// A named search plus a unique id and when it was saved. Searches saved before names
// existed have no name.
export type SavedSearch = {
  key: string;
  name?: string;
  savedAt: number;
} & ExploreV2Search;

export type SavedSearchInput = Omit<SavedSearch, "savedAt">;

export interface ExploreV2SearchesSlice {
  exploreRecentSearches: {
    subjects: ExploreV2Subject[];
    places: Place[];
    recordSubject: ( _subject: ExploreV2Subject ) => void;
    recordPlace: ( _place: Place ) => void;
    clearRecents: ( ) => void;
  };
  exploreSavedSearches: {
    searches: SavedSearch[];
    saveSearch: ( _search: SavedSearchInput ) => void;
    updateSearch: ( _key: string, _search: ExploreV2Search ) => void;
    removeSearch: ( _key: string ) => void;
    clearSavedSearches: ( ) => void;
  };
  // The Explore tab's most recent search, restored when the app relaunches
  lastExploreSearch: ExploreV2Search | null;
  setLastExploreSearch: ( _search: ExploreV2Search ) => void;
}

const createExploreV2SearchesSlice: StateCreator<ExploreV2SearchesSlice> = set => ( {
  exploreRecentSearches: {
    subjects: [],
    places: [],
    recordSubject: subject => set( state => ( {
      exploreRecentSearches: {
        ...state.exploreRecentSearches,
        subjects: addRecent(
          state.exploreRecentSearches.subjects,
          subject,
          subjectKey,
        ),
      },
    } ) ),
    recordPlace: place => set( state => ( {
      exploreRecentSearches: {
        ...state.exploreRecentSearches,
        places: addRecent(
          state.exploreRecentSearches.places,
          place,
          placeKey,
        ),
      },
    } ) ),
    clearRecents: ( ) => set( state => ( {
      exploreRecentSearches: {
        ...state.exploreRecentSearches,
        subjects: [],
        places: [],
      },
    } ) ),
  },
  exploreSavedSearches: {
    searches: [],
    saveSearch: search => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: [
          { ...search, savedAt: Date.now( ) },
          ...state.exploreSavedSearches.searches,
        ],
      },
    } ) ),
    updateSearch: ( key, search ) => set( state => ( {
      exploreSavedSearches: {
        ...state.exploreSavedSearches,
        searches: state.exploreSavedSearches.searches.map( saved => ( saved.key === key
          ? { ...saved, ...search, key }
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
  },
  lastExploreSearch: null,
  setLastExploreSearch: lastExploreSearch => set( { lastExploreSearch } ),
} );

export default createExploreV2SearchesSlice;
