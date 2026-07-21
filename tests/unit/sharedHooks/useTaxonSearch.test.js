import { act, renderHook, waitFor } from "@testing-library/react-native";
import useTaxonSearch from "sharedHooks/useTaxonSearch";
import factory from "tests/factory";

const mockIconicTaxa = [
  factory( "LocalTaxon" ),
];

jest.mock( "sharedHooks/useIconicTaxa", ( ) => ( {
  __esModule: true,
  default: ( ) => mockIconicTaxa,
} ) );

const mockSearchTaxa = jest.fn( ( ) => Promise.resolve( [] ) );
jest.mock( "api/taxa", ( ) => ( {
  __esModule: true,
  searchTaxa: ( ...args ) => mockSearchTaxa( ...args ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  __esModule: true,
  getJWT: jest.fn( ( ) => Promise.resolve( "jwt-token" ) ),
} ) );

const mockSafeRealmWrite = jest.fn( );
jest.mock( "sharedHelpers/safeRealmWrite", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockSafeRealmWrite( ...args ),
} ) );

jest.mock( "realmModels/Taxon", ( ) => ( {
  __esModule: true,
  default: {
    mapApiToRealm: jest.fn( taxon => taxon ),
    forUpdate: jest.fn( taxon => taxon ),
    compileSearchableName: jest.fn( ( ) => "" ),
  },
} ) );

const mockRealmObjects = jest.fn( ( ) => [] );
const mockRealmCreate = jest.fn( );
jest.mock( "providers/contexts", ( ) => {
  // A single, stable realm reference so the hook's memoized callbacks and
  // effects don't re-run on every render (which would loop indefinitely).
  const realm = {
    objects: ( ...args ) => mockRealmObjects( ...args ),
    create: ( ...args ) => mockRealmCreate( ...args ),
  };
  return {
    __esModule: true,
    RealmContext: {
      useRealm: ( ) => realm,
    },
  };
} );

describe( "useTaxonSearch", ( ) => {
  afterEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "should return iconic taxa by default", ( ) => {
    const { result } = renderHook( ( ) => useTaxonSearch( ) );
    const { taxa } = result.current;
    expect( taxa[0] ).toEqual( mockIconicTaxa[0] );
  } );

  it( "should search local Realm taxa when given a query", async ( ) => {
    renderHook( ( ) => useTaxonSearch( "foo" ) );
    await waitFor( ( ) => {
      expect( mockRealmObjects ).toHaveBeenCalledWith( "Taxon" );
    } );
  } );

  it( "should not search local taxa for an empty query", ( ) => {
    renderHook( ( ) => useTaxonSearch( "" ) );
    expect( mockRealmObjects ).not.toHaveBeenCalledWith( "Taxon" );
  } );

  it( "should fetch remote taxa and save them to Realm via updateLocalSpeciesDb", async ( ) => {
    mockSearchTaxa.mockResolvedValueOnce( [factory( "LocalTaxon" )] );
    const { result } = renderHook( ( ) => useTaxonSearch( "foo" ) );
    await act( async ( ) => {
      await result.current.updateLocalSpeciesDb( );
    } );
    expect( mockSearchTaxa ).toHaveBeenCalledWith(
      { q: "foo" },
      expect.objectContaining( { api_token: "jwt-token" } ),
    );
    expect( mockSafeRealmWrite ).toHaveBeenCalled( );
  } );

  it( "should not fetch remote taxa for an empty query", async ( ) => {
    const { result } = renderHook( ( ) => useTaxonSearch( "" ) );
    await act( async ( ) => {
      await result.current.updateLocalSpeciesDb( );
    } );
    expect( mockSearchTaxa ).not.toHaveBeenCalled( );
  } );
} );
