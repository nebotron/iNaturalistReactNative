import useStore, { zustandStorage } from "stores/useStore";

describe( "Explore filter persistence", ( ) => {
  const initialStoreState = useStore.getState( );

  beforeEach( ( ) => {
    useStore.persist.clearStorage( );
    useStore.setState( initialStoreState, true );
  } );

  it( "persists rootStoredParams and rootExploreView to MMKV storage", ( ) => {
    const storedParams = {
      researchGrade: false,
      needsID: true,
      sortBy: "DATE_OBSERVED_NEWEST",
    };
    const savedExploreFilters = [
      {
        id: "saved-filter-1",
        name: "Needs ID nearby",
        createdAt: 123,
        params: storedParams,
      },
    ];

    useStore.setState( {
      rootStoredParams: storedParams,
      rootExploreView: "species",
      savedExploreFilters,
    } );

    const persisted = field => JSON.parse( zustandStorage.getItem( `persisted-zustand.${field}` ) );

    expect( persisted( "rootStoredParams" ) ).toEqual( storedParams );
    expect( persisted( "rootExploreView" ) ).toBe( "species" );
    expect( persisted( "savedExploreFilters" ) ).toEqual( savedExploreFilters );
  } );
} );
