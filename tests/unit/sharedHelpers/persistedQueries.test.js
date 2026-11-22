import { QueryClient } from "@tanstack/react-query";
import {
  clearPersistedQueries,
  PERSISTED_QUERY_META,
  PERSISTED_QUERY_TTL_MS,
  persistQueries,
  readPersistedQuery,
  readPersistedQueryUpdatedAt,
} from "sharedHelpers/persistedQueries";

const KEY = ["exploreResults", { taxon_id: 1 }];

const infiniteData = pageCount => ( {
  pages: Array.from( { length: pageCount }, ( _, i ) => ( { page: i + 1, results: [i] } ) ),
  pageParams: [undefined, ...Array.from( { length: pageCount - 1 }, ( _, i ) => i + 2 )],
} );

describe( "persistedQueries", ( ) => {
  let queryClient;
  let stop;

  beforeEach( ( ) => {
    jest.useFakeTimers( );
    clearPersistedQueries( );
    queryClient = new QueryClient( );
    stop = persistQueries( queryClient );
  } );

  afterEach( ( ) => {
    stop( );
    queryClient.clear( );
    jest.useRealTimers( );
  } );

  const store = ( key, data, meta = PERSISTED_QUERY_META ) => {
    queryClient.getQueryCache( ).build( queryClient, { queryKey: key, meta } );
    queryClient.setQueryData( key, data );
    const fetchedAt = Date.now( );
    // Past the write delay
    jest.advanceTimersByTime( 1000 );
    return fetchedAt;
  };

  it( "restores a marked query's pages, with the first page param undefined", ( ) => {
    const fetchedAt = store( KEY, infiniteData( 2 ) );
    expect( readPersistedQuery( KEY ) ).toEqual( infiniteData( 2 ) );
    expect( readPersistedQuery( KEY ).pageParams[0] ).toBeUndefined( );
    expect( readPersistedQueryUpdatedAt( KEY ) ).toEqual( fetchedAt );
  } );

  it( "doesn't save queries that aren't marked", ( ) => {
    store( KEY, infiniteData( 1 ), null );
    expect( readPersistedQuery( KEY ) ).toBeUndefined( );
  } );

  it( "keeps only the first 10 pages", ( ) => {
    store( KEY, infiniteData( 15 ) );
    const restored = readPersistedQuery( KEY );
    expect( restored.pages ).toHaveLength( 10 );
    expect( restored.pageParams ).toHaveLength( 10 );
  } );

  it( "drops results older than the TTL", ( ) => {
    const fetchedAt = store( KEY, infiniteData( 1 ) );
    jest.setSystemTime( fetchedAt + PERSISTED_QUERY_TTL_MS - 1 );
    expect( readPersistedQuery( KEY ) ).toEqual( infiniteData( 1 ) );
    jest.setSystemTime( fetchedAt + PERSISTED_QUERY_TTL_MS );
    expect( readPersistedQuery( KEY ) ).toBeUndefined( );
    expect( readPersistedQueryUpdatedAt( KEY ) ).toBeUndefined( );
  } );

  it( "keeps a separate entry for each key", ( ) => {
    const otherKey = ["exploreResults", { taxon_id: 2 }];
    store( KEY, infiniteData( 1 ) );
    store( otherKey, infiniteData( 3 ) );
    expect( readPersistedQuery( KEY ).pages ).toHaveLength( 1 );
    expect( readPersistedQuery( otherKey ).pages ).toHaveLength( 3 );
  } );

  it( "clears everything", ( ) => {
    store( KEY, infiniteData( 1 ) );
    clearPersistedQueries( );
    expect( readPersistedQuery( KEY ) ).toBeUndefined( );
  } );
} );
