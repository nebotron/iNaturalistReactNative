import isEqual from "lodash/isEqual";
import type { DATE_OBSERVED, DATE_UPLOADED, ExploreState } from "providers/ExploreContext";

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
  // Parse as local date to avoid UTC-vs-local timezone shift on YYYY-MM-DD strings
  const [year, month, day] = dateStr.split( "-" ).map( Number );
  const d = new Date( year, month - 1, day );
  return Math.round( ( d.getTime( ) - today.getTime( ) ) / ( 1000 * 60 * 60 * 24 ) );
};

const offsetToIsoDate = ( offset: number ): string => {
  const d = new Date( );
  d.setHours( 0, 0, 0, 0 );
  d.setDate( d.getDate( ) + offset );
  // Use local date parts to avoid UTC-vs-local timezone shift
  const year = d.getFullYear( );
  const month = String( d.getMonth( ) + 1 ).padStart( 2, "0" );
  const day = String( d.getDate( ) ).padStart( 2, "0" );
  return `${year}-${month}-${day}`;
};

export const getRelativeDateOffsets = (
  state: ExploreState,
): RelativeDateOffsets => {
  const offsets: RelativeDateOffsets = {};

  // Compared against string literals (rather than the DATE_OBSERVED/DATE_UPLOADED
  // enums) so this module doesn't pull in providers/ExploreContext as a runtime
  // dependency, which transitively drags in geolocation/permission/Realm code.
  if ( state.dateObserved === ( "DATE_RANGE" as DATE_OBSERVED ) ) {
    if ( state.d1 ) offsets.relativeD1 = dateToOffset( state.d1 );
    if ( state.d2 ) offsets.relativeD2 = dateToOffset( state.d2 );
  } else if ( state.dateObserved === ( "EXACT_DATE" as DATE_OBSERVED ) && state.observed_on ) {
    offsets.relativeObservedOn = dateToOffset( state.observed_on );
  }

  if ( state.dateUploaded === ( "DATE_RANGE" as DATE_UPLOADED ) ) {
    if ( state.created_d1 ) offsets.relativeCreatedD1 = dateToOffset( state.created_d1 );
    if ( state.created_d2 ) offsets.relativeCreatedD2 = dateToOffset( state.created_d2 );
  } else if ( state.dateUploaded === ( "EXACT_DATE" as DATE_UPLOADED ) && state.created_on ) {
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
    d1: relativeD1 !== undefined
      ? offsetToIsoDate( relativeD1 )
      : params.d1,
    d2: relativeD2 !== undefined
      ? offsetToIsoDate( relativeD2 )
      : params.d2,
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

// Saved filters are persisted with JSON.stringify (see the zustand persist
// config), which drops every key whose value is `undefined`. The live Explore
// state, by contrast, keeps those keys (the reducer sets fields to `undefined`
// rather than deleting them). Round-tripping both operands through JSON before
// comparing normalizes that asymmetry so a rehydrated filter can still match
// the current state.
const normalizeExploreParamsForComparison = (
  params: ExploreState,
): ExploreState => JSON.parse( JSON.stringify( params ) );

export const isSavedExploreFilterActive = (
  currentParams: ExploreState,
  savedFilter: SavedExploreFilter,
): boolean => {
  const resolvedParams = resolveRelativeDates( savedFilter.params, {
    relativeD1: savedFilter.relativeD1,
    relativeD2: savedFilter.relativeD2,
    relativeObservedOn: savedFilter.relativeObservedOn,
    relativeCreatedD1: savedFilter.relativeCreatedD1,
    relativeCreatedD2: savedFilter.relativeCreatedD2,
    relativeCreatedOn: savedFilter.relativeCreatedOn,
  } );
  return isEqual(
    normalizeExploreParamsForComparison( currentParams ),
    normalizeExploreParamsForComparison( resolvedParams ),
  );
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
