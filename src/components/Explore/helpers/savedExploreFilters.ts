import type { ExploreState } from "providers/ExploreContext";
import { DATE_OBSERVED, DATE_UPLOADED } from "providers/ExploreContext";

// Days offset from today for each date field (0 = today, -30 = 30 days ago).
export interface RelativeDateOffsets {
  relativeD1?: number;
  relativeD2?: number;
  relativeObservedOn?: number;
  relativeCreatedD1?: number;
  relativeCreatedD2?: number;
  relativeCreatedOn?: number;
}

export interface SavedExploreFilter {
  id: string;
  name: string;
  createdAt: number;
  params: ExploreState;
  view?: string;
  observationsLayout?: string;
  relativeD1?: number;
  relativeD2?: number;
  relativeObservedOn?: number;
  relativeCreatedD1?: number;
  relativeCreatedD2?: number;
  relativeCreatedOn?: number;
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
): RelativeDateOffsets => {
  const offsets: RelativeDateOffsets = {};

  if ( state.dateObserved === DATE_OBSERVED.DATE_RANGE ) {
    if ( state.d1 ) offsets.relativeD1 = dateToOffset( state.d1 );
    if ( state.d2 ) offsets.relativeD2 = dateToOffset( state.d2 );
  } else if ( state.dateObserved === DATE_OBSERVED.EXACT_DATE && state.observed_on ) {
    offsets.relativeObservedOn = dateToOffset( state.observed_on );
  }

  if ( state.dateUploaded === DATE_UPLOADED.DATE_RANGE ) {
    if ( state.created_d1 ) offsets.relativeCreatedD1 = dateToOffset( state.created_d1 );
    if ( state.created_d2 ) offsets.relativeCreatedD2 = dateToOffset( state.created_d2 );
  } else if ( state.dateUploaded === DATE_UPLOADED.EXACT_DATE && state.created_on ) {
    offsets.relativeCreatedOn = dateToOffset( state.created_on );
  }

  return offsets;
};

export const resolveRelativeDates = (
  params: ExploreState,
  offsets: RelativeDateOffsets,
): ExploreState => {
  const {
    relativeD1,
    relativeD2,
    relativeObservedOn,
    relativeCreatedD1,
    relativeCreatedD2,
    relativeCreatedOn,
  } = offsets;

  if (
    relativeD1 === undefined
    && relativeD2 === undefined
    && relativeObservedOn === undefined
    && relativeCreatedD1 === undefined
    && relativeCreatedD2 === undefined
    && relativeCreatedOn === undefined
  ) {
    return params;
  }

  return {
    ...params,
    d1: relativeD1 !== undefined ? offsetToIsoDate( relativeD1 ) : params.d1,
    d2: relativeD2 !== undefined ? offsetToIsoDate( relativeD2 ) : params.d2,
    observed_on: relativeObservedOn !== undefined
      ? offsetToIsoDate( relativeObservedOn )
      : params.observed_on,
    created_d1: relativeCreatedD1 !== undefined
      ? offsetToIsoDate( relativeCreatedD1 )
      : params.created_d1,
    created_d2: relativeCreatedD2 !== undefined
      ? offsetToIsoDate( relativeCreatedD2 )
      : params.created_d2,
    created_on: relativeCreatedOn !== undefined
      ? offsetToIsoDate( relativeCreatedOn )
      : params.created_on,
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
