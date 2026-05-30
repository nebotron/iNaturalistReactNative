import {
  hasSavedExploreFilterName,
  prepareExploreStateForStorage,
  sortSavedExploreFilters,
} from "components/Explore/helpers/savedExploreFilters";
import { initialExploreState } from "providers/ExploreContext";
import useStore, { zustandStorage } from "stores/useStore";

describe( "savedExploreFilters helpers", ( ) => {
  it( "sorts saved filters newest first", ( ) => {
    const sorted = sortSavedExploreFilters( [
      { id: "1", name: "Older", createdAt: 1, params: initialExploreState },
      { id: "2", name: "Newer", createdAt: 2, params: initialExploreState },
    ] );

    expect( sorted.map( filter => filter.id ) ).toEqual( ["2", "1"] );
  } );

  it( "detects duplicate saved filter names", ( ) => {
    const savedFilters = [
      { id: "1", name: "Birds", createdAt: 1, params: initialExploreState },
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
