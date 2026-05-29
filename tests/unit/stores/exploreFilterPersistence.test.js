import useStore, { zustandStorage } from "stores/useStore";

describe( "Explore filter persistence", ( ) => {
  const initialStoreState = useStore.getState( );

  beforeEach( ( ) => {
    zustandStorage.removeItem( "persisted-zustand" );
    useStore.setState( initialStoreState, true );
  } );

  it( "persists rootStoredParams and rootExploreView to MMKV storage", ( ) => {
    const storedParams = {
      researchGrade: false,
      needsID: true,
      sortBy: "DATE_OBSERVED_NEWEST",
    };

    useStore.setState( {
      rootStoredParams: storedParams,
      rootExploreView: "species",
    } );

    const persisted = JSON.parse( zustandStorage.getItem( "persisted-zustand" ) );

    expect( persisted.state.rootStoredParams ).toEqual( storedParams );
    expect( persisted.state.rootExploreView ).toBe( "species" );
  } );
} );
