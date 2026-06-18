import type {
  RelativeDateOffsets,
  SavedExploreFilter,
} from "components/Explore/helpers/savedExploreFilters";
import {
  hasSavedExploreFilterName,
} from "components/Explore/helpers/savedExploreFilters";
import type { ExploreState } from "providers/ExploreContext";
import { v4 as uuidv4 } from "uuid";
import type { StateCreator } from "zustand";

const DEFAULT_STATE = {
  rootStoredParams: {},
  rootExploreView: "observations",
  savedExploreFilters: [] as SavedExploreFilter[],
};

interface RootExploreSlice {
  rootStoredParams: object;
  setRootStoredParams: ( _params: object ) => void;
  rootExploreView: string;
  setRootExploreView: ( _view: string ) => void;
  savedExploreFilters: SavedExploreFilter[];
  addSavedExploreFilter: (
    name: string, params: ExploreState, view: string, observationsLayout: string,
    relativeDates?: RelativeDateOffsets
  ) => boolean;
  updateSavedExploreFilter: (
    id: string, params: ExploreState, view: string, observationsLayout: string,
    relativeDates?: RelativeDateOffsets
  ) => boolean;
  removeSavedExploreFilter: ( id: string ) => void;
}

const createRootExploreSlice: StateCreator<RootExploreSlice> = ( set, get ) => ( {
  ...DEFAULT_STATE,
  setRootStoredParams: rootStoredParams => set( ( ) => ( { rootStoredParams } ) ),
  setRootExploreView: rootExploreView => set( ( ) => ( { rootExploreView } ) ),
  addSavedExploreFilter: ( name, params, view, observationsLayout, relativeDates ) => {
    const trimmedName = name.trim( );

    if ( !trimmedName ) {
      return false;
    }

    if ( hasSavedExploreFilterName( get( ).savedExploreFilters, trimmedName ) ) {
      return false;
    }

    set( ( { savedExploreFilters } ) => ( {
      savedExploreFilters: [
        ...savedExploreFilters,
        {
          id: uuidv4( ),
          name: trimmedName,
          createdAt: Date.now( ),
          params,
          view,
          observationsLayout,
          ...relativeDates,
        },
      ],
    } ) );

    return true;
  },
  updateSavedExploreFilter: ( id, params, view, observationsLayout, relativeDates ) => {
    const savedFilterIndex = get( ).savedExploreFilters.findIndex(
      savedFilter => savedFilter.id === id,
    );

    if ( savedFilterIndex === -1 ) {
      return false;
    }

    set( ( { savedExploreFilters } ) => {
      const updatedSavedFilters = [...savedExploreFilters];
      const savedFilter = updatedSavedFilters[savedFilterIndex];

      updatedSavedFilters[savedFilterIndex] = {
        ...savedFilter,
        createdAt: Date.now( ),
        params,
        view,
        observationsLayout,
        relativeD1: undefined,
        relativeD2: undefined,
        relativeObservedOn: undefined,
        relativeCreatedD1: undefined,
        relativeCreatedD2: undefined,
        relativeCreatedOn: undefined,
        ...relativeDates,
      };

      return { savedExploreFilters: updatedSavedFilters };
    } );

    return true;
  },
  removeSavedExploreFilter: id => set( ( { savedExploreFilters } ) => ( {
    savedExploreFilters: savedExploreFilters.filter(
      savedFilter => savedFilter.id !== id,
    ),
  } ) ),
} );

export default createRootExploreSlice;
