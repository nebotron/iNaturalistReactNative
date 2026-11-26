import { renderHook, waitFor } from "@testing-library/react-native";
import { searchObservations } from "api/observations";
import useTaxonomicSortFetch from "components/MyObservations/hooks/useTaxonomicSortFetch";
import { Alert } from "react-native";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import useCurrentUser from "sharedHooks/useCurrentUser";
import useStore from "stores/useStore";
import factory from "tests/factory";
import setupUniqueRealm from "tests/helpers/uniqueRealm";

jest.mock( "api/observations", ( ) => ( {
  searchObservations: jest.fn( ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "jwt" ) ),
} ) );

jest.mock( "sharedHelpers/util", ( ) => ( {
  ...jest.requireActual( "sharedHelpers/util" ),
  sleep: jest.fn( ( ) => Promise.resolve( ) ),
} ) );

jest.mock( "sharedHooks/useCurrentUser", ( ) => ( {
  __esModule: true,
  default: jest.fn( ),
} ) );

// UNIQUE REALM SETUP
const mockRealmIdentifier = __filename;
const { mockRealmModelsIndex, uniqueRealmBeforeAll, uniqueRealmAfterAll } = setupUniqueRealm(
  mockRealmIdentifier,
);
jest.mock( "realmModels/index", ( ) => mockRealmModelsIndex );
jest.mock( "providers/contexts", ( ) => {
  const originalModule = jest.requireActual( "providers/contexts" );
  return {
    __esModule: true,
    ...originalModule,
    RealmContext: {
      ...originalModule.RealmContext,
      useRealm: ( ) => global.mockRealms[mockRealmIdentifier],
    },
  };
} );
beforeAll( uniqueRealmBeforeAll );
afterAll( uniqueRealmAfterAll );
// /UNIQUE REALM SETUP

const getRealm = ( ) => global.mockRealms[mockRealmIdentifier];

const mockUser = factory( "LocalUser" );

// Pages of 200, ids descending, like the API with order_by=id
const remoteObservations = count => Array.from( { length: count }, ( _, i ) => factory(
  "RemoteObservation",
  { id: count - i, user: { id: mockUser.id } },
) );

// Answers the count request and then each page, honoring id_below
const mockApi = observations => searchObservations.mockImplementation( async params => {
  if ( params.per_page === 0 ) return { total_results: observations.length, results: [] };
  const remaining = observations.filter( o => !params.id_below || o.id < params.id_below );
  return {
    total_results: observations.length,
    results: remaining.slice( 0, params.per_page ),
  };
} );

const pageRequests = ( ) => searchObservations.mock.calls
  .map( ( [params] ) => params )
  .filter( params => params.per_page > 0 );

const prepare = async taxonId => {
  const { result } = renderHook( ( ) => useTaxonomicSortFetch( ) );
  return result.current.prepareTaxonomicSort( taxonId );
};

beforeEach( ( ) => {
  const realm = getRealm( );
  realm.write( ( ) => realm.deleteAll( ) );
  useCurrentUser.mockReturnValue( mockUser );
  useStore.setState( {
    taxonomicFetch: null,
    taxonomicFetchCheckedFilterKey: null,
    myObservations: {
      ...useStore.getState( ).myObservations,
      observationsSort: OBSERVATIONS_SORT.TAXONOMY,
    },
  } );
} );

afterEach( ( ) => {
  jest.restoreAllMocks( );
  searchObservations.mockReset( );
} );

describe( "useTaxonomicSortFetch", ( ) => {
  it( "downloads every matching observation without asking when there are few", async ( ) => {
    const alertSpy = jest.spyOn( Alert, "alert" );
    mockApi( remoteObservations( 450 ) );

    expect( await prepare( ) ).toBe( true );

    await waitFor( ( ) => {
      expect( getRealm( ).objects( "Observation" ).length ).toEqual( 450 );
    } );
    expect( alertSpy ).not.toHaveBeenCalled( );
    expect( pageRequests( ).map( params => params.id_below ) ).toEqual( [undefined, 251, 51] );
    expect( pageRequests( )[0] ).toEqual( expect.objectContaining( {
      user_id: mockUser.id,
      order_by: "id",
      order: "desc",
    } ) );
    await waitFor( ( ) => expect( useStore.getState( ).taxonomicFetch ).toBeNull( ) );
  } );

  it( "passes the searched taxon to the API", async ( ) => {
    mockApi( remoteObservations( 3 ) );
    await prepare( 47126 );
    await waitFor( ( ) => expect( pageRequests( ).length ).toEqual( 1 ) );
    expect( searchObservations.mock.calls[0][0] ).toEqual( expect.objectContaining( {
      taxon_id: 47126,
      per_page: 0,
    } ) );
    expect( pageRequests( )[0].taxon_id ).toEqual( 47126 );
  } );

  it( "asks before downloading more than 1,000, and downloads nothing on No", async ( ) => {
    const alertSpy = jest.spyOn( Alert, "alert" ).mockImplementation(
      ( _title, _message, buttons ) => buttons[0].onPress( ),
    );
    mockApi( remoteObservations( 1001 ) );

    expect( await prepare( ) ).toBe( false );

    expect( alertSpy ).toHaveBeenCalledTimes( 1 );
    expect( alertSpy.mock.calls[0][0] ).toContain( "1,001" );
    expect( pageRequests( ) ).toEqual( [] );
    expect( useStore.getState( ).taxonomicFetch ).toBeNull( );
  } );

  it( "downloads more than 1,000 after Yes", async ( ) => {
    jest.spyOn( Alert, "alert" ).mockImplementation(
      ( _title, _message, buttons ) => buttons[1].onPress( ),
    );
    mockApi( remoteObservations( 1001 ) );

    expect( await prepare( ) ).toBe( true );

    await waitFor( ( ) => {
      expect( getRealm( ).objects( "Observation" ).length ).toEqual( 1001 );
    } );
  } );

  it( "doesn't download when everything is already on the device", async ( ) => {
    const observations = remoteObservations( 5 );
    mockApi( observations );
    await prepare( );
    await waitFor( ( ) => expect( useStore.getState( ).taxonomicFetch ).toBeNull( ) );
    searchObservations.mockClear( );

    expect( await prepare( ) ).toBe( true );

    expect( pageRequests( ) ).toEqual( [] );
  } );

  it( "stops downloading when the sort changes", async ( ) => {
    mockApi( remoteObservations( 450 ) );
    // Change the sort as soon as the first page arrives
    const original = searchObservations.getMockImplementation( );
    searchObservations.mockImplementation( async params => {
      const response = await original( params );
      useStore.setState( {
        myObservations: {
          ...useStore.getState( ).myObservations,
          observationsSort: OBSERVATIONS_SORT.DATE_UPLOADED_NEWEST,
        },
      } );
      return response;
    } );

    await prepare( );

    await waitFor( ( ) => expect( useStore.getState( ).taxonomicFetch ).toBeNull( ) );
    expect( pageRequests( ).length ).toEqual( 1 );
  } );

  it( "sorts what's local without asking when logged out", async ( ) => {
    useCurrentUser.mockReturnValue( null );
    expect( await prepare( ) ).toBe( true );
    expect( searchObservations ).not.toHaveBeenCalled( );
  } );
} );
