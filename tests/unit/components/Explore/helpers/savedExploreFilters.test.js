import {
  getRelativeDateOffsets,
  hasSavedExploreFilterName,
  isSavedExploreFilterActive,
  prepareExploreStateForStorage,
  resolveRelativeDates,
  sortSavedExploreFilters,
} from "components/Explore/helpers/savedExploreFilters";
import { initialExploreState } from "providers/ExploreContext";
import useStore, { zustandStorage } from "stores/useStore";

// Returns a local YYYY-MM-DD string for a date offset from today
const localIsoDateOffset = offset => {
  const d = new Date( );
  d.setHours( 0, 0, 0, 0 );
  d.setDate( d.getDate( ) + offset );
  return [
    d.getFullYear( ),
    String( d.getMonth( ) + 1 ).padStart( 2, "0" ),
    String( d.getDate( ) ).padStart( 2, "0" ),
  ].join( "-" );
};

describe( "savedExploreFilters helpers", ( ) => {
  it( "sorts saved filters newest first", ( ) => {
    const sorted = sortSavedExploreFilters( [
      {
        id: "1", name: "Older", createdAt: 1, params: initialExploreState,
      },
      {
        id: "2", name: "Newer", createdAt: 2, params: initialExploreState,
      },
    ] );

    expect( sorted.map( filter => filter.id ) ).toEqual( ["2", "1"] );
  } );

  it( "detects duplicate saved filter names", ( ) => {
    const savedFilters = [
      {
        id: "1", name: "Birds", createdAt: 1, params: initialExploreState,
      },
    ];

    expect( hasSavedExploreFilterName( savedFilters, "birds" ) ).toBe( true );
    expect( hasSavedExploreFilterName( savedFilters, "Birds", "1" ) ).toBe( false );
    expect( hasSavedExploreFilterName( savedFilters, "Plants" ) ).toBe( false );
  } );

  it( "removes ephemeral fields before saving explore state", ( ) => {
    const prepared = prepareExploreStateForStorage( {
      ...initialExploreState,
      return_bounds: true,
      needsID: true,
    } );

    expect( prepared.return_bounds ).toBeUndefined( );
    expect( prepared.needsID ).toBe( true );
  } );

  it( "getRelativeDateOffsets returns 0 for today and negative for past dates", ( ) => {
    const today = localIsoDateOffset( 0 );
    const sevenDaysAgo = localIsoDateOffset( -7 );

    const offsets = getRelativeDateOffsets( {
      ...initialExploreState,
      dateObserved: "DATE_RANGE",
      d1: sevenDaysAgo,
      d2: today,
    } );

    expect( offsets.relativeD1 ).toBe( -7 );
    expect( offsets.relativeD2 ).toBe( 0 );
  } );

  it( "matches the active filter after JSON persistence drops undefined keys", ( ) => {
    const currentParams = prepareExploreStateForStorage( {
      ...initialExploreState,
      needsID: true,
    } );

    // Simulate the persistence round-trip: JSON.stringify drops undefined keys,
    // so the rehydrated params has a different key set than the live state.
    const persistedFilter = {
      id: "1",
      name: "Needs ID",
      createdAt: 1,
      params: JSON.parse( JSON.stringify( currentParams ) ),
    };

    expect( isSavedExploreFilterActive( currentParams, persistedFilter ) ).toBe( true );
  } );

  it( "does not match when the current filter differs from a saved filter", ( ) => {
    const savedParams = prepareExploreStateForStorage( {
      ...initialExploreState,
      needsID: true,
    } );
    const persistedFilter = {
      id: "1",
      name: "Needs ID",
      createdAt: 1,
      params: JSON.parse( JSON.stringify( savedParams ) ),
    };
    const currentParams = prepareExploreStateForStorage( {
      ...initialExploreState,
      needsID: false,
    } );

    expect( isSavedExploreFilterActive( currentParams, persistedFilter ) ).toBe( false );
  } );

  it( "resolveRelativeDates round-trips correctly (no timezone drift)", ( ) => {
    const today = localIsoDateOffset( 0 );
    const sevenDaysAgo = localIsoDateOffset( -7 );

    const state = {
      ...initialExploreState,
      dateObserved: "DATE_RANGE",
      d1: sevenDaysAgo,
      d2: today,
    };
    const offsets = getRelativeDateOffsets( state );
    const resolved = resolveRelativeDates( state, offsets );

    expect( resolved.d1 ).toBe( sevenDaysAgo );
    expect( resolved.d2 ).toBe( today );
  } );

  it( "resolveRelativeDates produces stable dates on repeated calls (no per-open drift)", ( ) => {
    const today = localIsoDateOffset( 0 );

    const state = {
      ...initialExploreState,
      dateObserved: "DATE_RANGE",
      d1: today,
      d2: today,
    };

    // Simulate what happens on each Explore tab open: resolve → recompute offsets → resolve again
    const offsets1 = getRelativeDateOffsets( state );
    const resolved1 = resolveRelativeDates( state, offsets1 );
    const offsets2 = getRelativeDateOffsets( resolved1 );
    const resolved2 = resolveRelativeDates( resolved1, offsets2 );

    expect( resolved1.d1 ).toBe( today );
    expect( resolved2.d1 ).toBe( today );
    expect( offsets1.relativeD1 ).toBe( 0 );
    expect( offsets2.relativeD1 ).toBe( 0 );
  } );
} );

describe( "savedExploreFilters store", ( ) => {
  const initialStoreState = useStore.getState( );

  beforeEach( ( ) => {
    zustandStorage.removeItem( "persisted-zustand" );
    useStore.setState( initialStoreState, true );
  } );

  it( "adds and removes saved explore filters", ( ) => {
    const params = {
      ...initialExploreState,
      needsID: true,
    };

    expect(
      useStore.getState( ).addSavedExploreFilter( "Nearby birds", params ),
    ).toBe( true );
    expect( useStore.getState( ).savedExploreFilters ).toHaveLength( 1 );
    expect( useStore.getState( ).savedExploreFilters[0].name ).toBe( "Nearby birds" );
    expect(
      useStore.getState( ).addSavedExploreFilter( "nearby birds", params ),
    ).toBe( false );

    const savedFilterId = useStore.getState( ).savedExploreFilters[0].id;
    useStore.getState( ).removeSavedExploreFilter( savedFilterId );

    expect( useStore.getState( ).savedExploreFilters ).toHaveLength( 0 );
  } );

  it( "updates saved explore filter params", ( ) => {
    const initialParams = {
      ...initialExploreState,
      needsID: true,
    };
    const updatedParams = {
      ...initialExploreState,
      needsID: false,
      sortBy: "DATE_OBSERVED_NEWEST",
    };

    useStore.getState( ).addSavedExploreFilter( "Nearby birds", initialParams );
    const savedFilterId = useStore.getState( ).savedExploreFilters[0].id;
    const originalCreatedAt = useStore.getState( ).savedExploreFilters[0].createdAt;

    expect(
      useStore.getState( ).updateSavedExploreFilter( savedFilterId, updatedParams ),
    ).toBe( true );
    expect(
      useStore.getState( ).updateSavedExploreFilter( "missing-id", updatedParams ),
    ).toBe( false );

    const updatedFilter = useStore.getState( ).savedExploreFilters[0];
    expect( updatedFilter.name ).toBe( "Nearby birds" );
    expect( updatedFilter.params ).toEqual( updatedParams );
    expect( updatedFilter.createdAt ).toBeGreaterThanOrEqual( originalCreatedAt );
  } );

  it( "persists savedExploreFilters to MMKV storage", ( ) => {
    const params = {
      ...initialExploreState,
      sortBy: "DATE_OBSERVED_NEWEST",
    };

    useStore.getState( ).addSavedExploreFilter( "Recent observations", params );

    const persisted = JSON.parse( zustandStorage.getItem( "persisted-zustand" ) );

    expect( persisted.state.savedExploreFilters ).toHaveLength( 1 );
    expect( persisted.state.savedExploreFilters[0].name ).toBe( "Recent observations" );
    expect( persisted.state.savedExploreFilters[0].params.sortBy ).toBe(
      "DATE_OBSERVED_NEWEST",
    );
  } );
} );
