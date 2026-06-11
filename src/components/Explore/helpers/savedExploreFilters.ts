import type { ExploreState } from "providers/ExploreContext";

export interface SavedExploreFilter {
  id: string;
  name: string;
  createdAt: number;
  params: ExploreState;
}

export const prepareExploreStateForStorage = (
  state: ExploreState,
): ExploreState => ( {
  ...state,
  return_bounds: undefined,
} );

export const sortSavedExploreFilters = (
  savedFilters: SavedExploreFilter[],
): SavedExploreFilter[] => (
  [...savedFilters].sort( ( a, b ) => b.createdAt - a.createdAt )
);

export const hasSavedExploreFilterName = (
  savedFilters: SavedExploreFilter[],
  name: string,
  excludeId?: string,
): boolean => {
  const normalizedName = name.trim().toLowerCase( );

  return savedFilters.some( savedFilter => (
    savedFilter.id !== excludeId
    && savedFilter.name.trim().toLowerCase( ) === normalizedName
  ) );
};
