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
// existed have no name.
export type SavedSearch = {
  key: string;
  name?: string;
  savedAt: number;
} & ExploreV2SearchWithTab;

export type SavedSearchInput = Omit<SavedSearch, "savedAt">;

export interface ExploreV2SearchesSlice {
  exploreSavedSearches: {
    searches: SavedSearch[];
    saveSearch: ( _search: SavedSearchInput ) => void;
    updateSearch: ( _key: string, _search: ExploreV2SearchWithTab ) => void;
    removeSearch: ( _key: string ) => void;
    clearSavedSearches: ( ) => void;
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
