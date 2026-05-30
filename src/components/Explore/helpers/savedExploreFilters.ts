import type { ExploreState } from "providers/ExploreContext";
import { DATE_OBSERVED } from "providers/ExploreContext";

export interface SavedExploreFilter {
  id: string;
  name: string;
  createdAt: number;
  params: ExploreState;
  view?: string;
  observationsLayout?: string;
  // Days offset from today for relative date ranges (0 = today, -30 = 30 days ago).
  // Only set when dateObserved === DATE_OBSERVED.DATE_RANGE.
  relativeD1?: number;
  relativeD2?: number;
}

export const prepareExploreStateForStorage = (
  state: ExploreState,
): ExploreState => ( {
  ...state,
  return_bounds: undefined,
} );

const dateToOffset = ( dateStr: string ): number => {
  const today = new Date( );
  today.setHours( 0, 0, 0, 0 );
  const d = new Date( dateStr );
  d.setHours( 0, 0, 0, 0 );
  return Math.round( ( d.getTime( ) - today.getTime( ) ) / ( 1000 * 60 * 60 * 24 ) );
};

const offsetToIsoDate = ( offset: number ): string => {
  const d = new Date( );
  d.setHours( 0, 0, 0, 0 );
  d.setDate( d.getDate( ) + offset );
  return d.toISOString( ).slice( 0, 10 );
};

export const getRelativeDateOffsets = (
  state: ExploreState,
): { relativeD1?: number; relativeD2?: number } => {
  if ( state.dateObserved !== DATE_OBSERVED.DATE_RANGE ) {
    return {};
  }
  return {
    relativeD1: state.d1
      ? dateToOffset( state.d1 )
      : undefined,
    relativeD2: state.d2
      ? dateToOffset( state.d2 )
      : undefined,
  };
};

export const resolveRelativeDates = (
  params: ExploreState,
  relativeD1?: number,
  relativeD2?: number,
): ExploreState => {
  if ( relativeD1 === undefined && relativeD2 === undefined ) {
    return params;
  }
  return {
    ...params,
    d1: relativeD1 !== undefined
      ? offsetToIsoDate( relativeD1 )
      : params.d1,
    d2: relativeD2 !== undefined
      ? offsetToIsoDate( relativeD2 )
      : params.d2,
  };
};

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
