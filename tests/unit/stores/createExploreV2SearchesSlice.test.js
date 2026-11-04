import { defaultExploreV2Filters } from "providers/ExploreV2Context";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import { SPECIES_SORT } from "sharedHelpers/speciesSort";
import { subjectKey } from "stores/createExploreV2SearchesSlice";
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
