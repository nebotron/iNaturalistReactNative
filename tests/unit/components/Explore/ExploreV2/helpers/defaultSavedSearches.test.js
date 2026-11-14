import defaultSavedSearches from "components/Explore/ExploreV2/helpers/defaultSavedSearches";
import { EXPLORE_V2_PLACE_MODE } from "providers/ExploreV2Context";
import useStore from "stores/useStore";

const t = key => ( { "My-species": "My species", "Unobserved-by-me": "Unobserved by me" }[key] );
const user = { id: 7, login: "kueda" };
const saved = ( ) => useStore.getState( ).exploreSavedSearches;

beforeEach( ( ) => {
  useStore.setState( state => ( {
    exploreSavedSearches: {
      ...state.exploreSavedSearches,
      searches: [],
      defaultsAddedForUserIds: [],
    },
  } ) );
} );

describe( "defaultSavedSearches", ( ) => {
  it( "shows every species the user observed", ( ) => {
    const [mySpecies] = defaultSavedSearches( user, t );
    expect( mySpecies.name ).toEqual( "My species" );
    expect( mySpecies.subject ).toEqual( { type: "user", user } );
    expect( mySpecies.location.placeMode ).toEqual( EXPLORE_V2_PLACE_MODE.WORLDWIDE );
    expect( mySpecies.activeTab ).toEqual( "species" );
    expect( mySpecies.filters.casual ).toBe( true );
  } );

  it( "maps nearby observations of species not in My species", ( ) => {
    const [, unobserved] = defaultSavedSearches( user, t );
    expect( unobserved.name ).toEqual( "Unobserved by me" );
    expect( unobserved.location ).toEqual( {
      placeMode: EXPLORE_V2_PLACE_MODE.NEARBY,
      radius: 10,
    } );
    expect( unobserved.observationsLayout ).toEqual( "map" );
    expect( unobserved.filters.excludeSpeciesInSavedSearch ).toEqual( "My species" );
  } );
} );

describe( "addDefaultSearches", ( ) => {
  it( "adds the defaults once per user", ( ) => {
    saved( ).addDefaultSearches( 7, defaultSavedSearches( user, t ) );
    saved( ).addDefaultSearches( 7, defaultSavedSearches( user, t ) );
    expect( saved( ).searches.map( s => s.name ) ).toEqual( ["My species", "Unobserved by me"] );
  } );

  it( "doesn't add a default whose name is taken", ( ) => {
    saved( ).saveSearch( { ...defaultSavedSearches( user, t )[1], key: "mine" } );
    saved( ).addDefaultSearches( 7, defaultSavedSearches( user, t ) );
    expect( saved( ).searches.map( s => s.key ) ).toEqual( ["mine", "default-my-species-7"] );
  } );
} );
