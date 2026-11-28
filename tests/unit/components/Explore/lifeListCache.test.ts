import { lifeListCacheKey, syncLifeList } from "components/Explore/lifeListCache";

const mockStorage = new Map<string, string>( );
jest.mock( "stores/useStore", ( ) => ( {
  __esModule: true,
  zustandStorage: {
    setItem: ( key: string, value: string ) => mockStorage.set( key, value ),
    getItem: ( key: string ) => mockStorage.get( key ) ?? null,
    removeItem: ( key: string ) => mockStorage.delete( key ),
  },
} ) );
jest.mock( "api/observations", ( ) => ( {
  searchObservations: jest.fn( async ( ) => ( { results: [] } ) ),
} ) );
jest.mock( "components/LifeList/LiferGridItem", ( ) => ( {
  fetchMissingDisplayData: jest.fn( async ( ) => undefined ),
  toLifer: jest.fn( ),
} ) );
jest.mock( "sharedHelpers/logging", ( ) => ( {
  withRequestTimeout: ( opts: unknown, request: ( o: unknown ) => unknown ) => request( opts ),
} ) );

const INDEX_KEY = "exploreLifeList-v1-index";
const V2_KEY = "exploreLifeList-v2-[[\"user_id\",1]]";

describe( "life list cache", ( ) => {
  beforeEach( ( ) => mockStorage.clear( ) );

  it( "removes caches left by an earlier key version", async ( ) => {
    mockStorage.set( V2_KEY, "{\"entries\":[],\"display\":{},\"lastSync\":null}" );
    mockStorage.set( INDEX_KEY, JSON.stringify( [V2_KEY] ) );

    await syncLifeList( { user_id: 1 }, { api_token: null } );

    const key = lifeListCacheKey( { user_id: 1 } );
    expect( mockStorage.has( V2_KEY ) ).toBe( false );
    expect( mockStorage.has( key ) ).toBe( true );
    expect( JSON.parse( mockStorage.get( INDEX_KEY ) as string ) ).toEqual( [key] );
  } );

  it( "keeps the ten most recent current caches", async ( ) => {
    for ( let i = 0; i < 11; i += 1 ) {
      // eslint-disable-next-line no-await-in-loop
      await syncLifeList( { user_id: i }, { api_token: null } );
    }
    expect( mockStorage.has( lifeListCacheKey( { user_id: 0 } ) ) ).toBe( false );
    expect( mockStorage.has( lifeListCacheKey( { user_id: 10 } ) ) ).toBe( true );
    expect( JSON.parse( mockStorage.get( INDEX_KEY ) as string ) ).toHaveLength( 10 );
  } );
} );
