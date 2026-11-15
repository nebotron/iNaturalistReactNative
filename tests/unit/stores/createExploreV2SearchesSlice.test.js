import { defaultExploreV2Filters } from "providers/ExploreV2Context";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import { SPECIES_SORT } from "sharedHelpers/speciesSort";
import { findSavedSearchByName, subjectKey } from "stores/createExploreV2SearchesSlice";
import useStore, { zustandStorage } from "stores/useStore";
import { savedSearch as search, taxonSubject } from "tests/helpers/savedSearch";

const saved = ( ) => useStore.getState( ).exploreSavedSearches;

beforeEach( ( ) => {
  saved( ).clearSavedSearches( );
} );

describe( "subjectKey", ( ) => {
  it( "keys each subject type by its record", ( ) => {
    expect( subjectKey( taxonSubject( 12 ) ) ).toEqual( "taxon-12" );
    expect( subjectKey( { type: "user", user: { id: 7 } } ) ).toEqual( "user-7" );
    expect( subjectKey( { type: "project", project: { id: 9 } } ) ).toEqual( "project-9" );
    expect( subjectKey( { type: "unobserved", user: { id: 7 } } ) ).toEqual( "unobserved-7" );
    expect( subjectKey( { type: "unknown" } ) ).toEqual( "unknown" );
  } );
} );

describe( "exploreSavedSearches", ( ) => {
  it( "saves newest first", ( ) => {
    saved( ).saveSearch( search( ) );
    saved( ).saveSearch( search( { subject: taxonSubject( 13 ) } ) );

    expect( saved( ).searches.map( s => s.subject.taxon.id ) ).toEqual( [13, 12] );
  } );

  it( "keeps the sort it was saved with", ( ) => {
    saved( ).saveSearch( search( { sortBy: OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST } ) );

    expect( saved( ).searches[0].sortBy ).toEqual( OBSERVATIONS_SORT.DATE_OBSERVED_OLDEST );
    expect( saved( ).searches[0].speciesSortBy ).toEqual( SPECIES_SORT.COUNT_DESC );
  } );

  it( "overwrites a search in place, keeping its name", ( ) => {
    saved( ).saveSearch( { ...search( ), name: "Cup plants" } );
    const { key } = saved( ).searches[0];
    saved( ).updateSearch( key, search( { subject: taxonSubject( 13 ) } ) );

    expect( saved( ).searches ).toHaveLength( 1 );
    expect( saved( ).searches[0] ).toMatchObject( { key, name: "Cup plants" } );
    expect( saved( ).searches[0].subject.taxon.id ).toEqual( 13 );
  } );

  describe( "overwriting a search with one that excludes it", ( ) => {
    const excluding = ( name, overrides = {} ) => search( {
      filters: { ...defaultExploreV2Filters, excludeSpeciesInSavedSearch: name },
      ...overrides,
    } );

    it( "drops the exclusion of itself and keeps the rest", ( ) => {
      saved( ).saveSearch( { ...search( ), key: "backyard", name: "Backyard" } );
      saved( ).updateSearch( "backyard", excluding( "backyard", { subject: taxonSubject( 13 ) } ) );

      const [backyard] = saved( ).searches;
      expect( backyard.filters.excludeSpeciesInSavedSearch ).toBeNull( );
      expect( backyard.subject.taxon.id ).toEqual( 13 );
    } );

    it( "drops an exclusion that leads back to it through another search", ( ) => {
      saved( ).saveSearch( { ...search( ), key: "backyard", name: "Backyard" } );
      saved( ).saveSearch( { ...excluding( "Backyard" ), key: "rest", name: "Rest" } );
      saved( ).updateSearch( "backyard", excluding( "Rest" ) );

      const byKey = Object.fromEntries( saved( ).searches.map( s => [s.key, s] ) );
      expect( byKey.backyard.filters.excludeSpeciesInSavedSearch ).toBeNull( );
      expect( byKey.rest.filters.excludeSpeciesInSavedSearch ).toEqual( "Backyard" );
    } );

    it( "keeps an exclusion of a different search", ( ) => {
      saved( ).saveSearch( { ...search( ), key: "garden", name: "Garden" } );
      saved( ).saveSearch( { ...search( ), key: "backyard", name: "Backyard" } );
      saved( ).updateSearch( "backyard", excluding( "Garden" ) );

      expect( saved( ).searches.find( s => s.key === "backyard" ).filters )
        .toMatchObject( { excludeSpeciesInSavedSearch: "Garden" } );
    } );
  } );

  it( "finds a search by name ignoring case and surrounding space", ( ) => {
    saved( ).saveSearch( { ...search( ), name: "Cup plants" } );

    expect( findSavedSearchByName( saved( ).searches, " cup PLANTS " )?.name )
      .toEqual( "Cup plants" );
    expect( findSavedSearchByName( saved( ).searches, "Cup" ) ).toBeUndefined( );
  } );

  it( "removes a search by key", ( ) => {
    saved( ).saveSearch( search( ) );
    saved( ).removeSearch( saved( ).searches[0].key );

    expect( saved( ).searches ).toEqual( [] );
  } );

  it( "clears the whole list", ( ) => {
    saved( ).saveSearch( search( ) );
    saved( ).saveSearch( search( { subject: taxonSubject( 13 ) } ) );

    saved( ).clearSavedSearches( );

    expect( saved( ).searches ).toEqual( [] );
  } );

  it( "persists, so saved searches survive a restart", async ( ) => {
    saved( ).saveSearch( search( ) );
    // let the persist middleware flush
    await Promise.resolve( );

    const persisted = field => JSON.parse( zustandStorage.getItem( `persisted-zustand.${field}` ) );
    expect( persisted( "exploreSavedSearches" ).searches ).toHaveLength( 1 );
    expect( persisted( "exploreSavedSearches" ).searches[0].filters ).toEqual(
      defaultExploreV2Filters,
    );
  } );
} );
