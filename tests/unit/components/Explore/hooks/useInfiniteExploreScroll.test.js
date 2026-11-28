import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import inatjs from "inaturalistjs";
import React from "react";
import {
  clearPersistedQueries,
  persistQueries,
} from "sharedHelpers/persistedQueries";

jest.mock( "sharedHooks/useCurrentUser", ( ) => ( {
  __esModule: true,
  default: ( ) => null,
} ) );

// Stands in for the HTTP cache, which isn't under the mocked inatjs
const mockCacheFirst = new WeakSet( );
const mockServedFromCache = new WeakSet( );
jest.mock( "sharedHelpers/httpCache", ( ) => ( {
  preferCachedResponse: signal => {
    mockCacheFirst.add( signal );
    return signal;
  },
  requireNetworkResponse: signal => signal,
  wasServedFromCache: signal => mockServedFromCache.has( signal ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( null ) ),
} ) );

const PARAMS = { taxon_id: 47126, per_page: 20 };

const response = uuids => ( {
  total_results: uuids.length,
  page: 1,
  per_page: 20,
  results: uuids.map( ( uuid, i ) => ( { id: i + 1, uuid } ) ),
} );

// A fresh client stands in for the app restarting: nothing is in memory, and
// only what was written to disk remains
let queryClient;
let stopPersisting;
const startApp = ( ) => {
  stopPersisting?.( );
  queryClient = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
  stopPersisting = persistQueries( queryClient, { writeDelayMs: 0 } );
};

let rendered = [];
const renderExploreScroll = ( params = PARAMS ) => {
  const client = queryClient;
  const utils = renderHook(
    ( ) => useInfiniteExploreScroll( { params, enabled: true } ),
    {
      wrapper: ( { children } ) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  rendered.push( utils );
  return utils;
};

const uuidsOf = result => result.current.observations.map( obs => obs.uuid );

// Lets the write to disk, on a timer, happen
const flushPersistence = ( ) => act( async ( ) => {
  await new Promise( resolve => { setTimeout( resolve, 10 ); } );
} );

describe( "useInfiniteExploreScroll", ( ) => {
  beforeEach( ( ) => {
    clearPersistedQueries( );
    startApp( );
    inatjs.observations.search.mockReset( );
  } );

  afterEach( ( ) => {
    // Unmounted, then cleared, or the queries' two-day garbage collection
    // timers would keep Jest from exiting
    rendered.forEach( utils => utils.unmount( ) );
    rendered = [];
    stopPersisting( );
    queryClient.clear( );
  } );

  // The search asked to prefer the cache is answered from it
  const answerFromCache = uuids => ( params, { signal } ) => {
    if ( !mockCacheFirst.has( signal ) ) return null;
    mockServedFromCache.add( signal );
    return Promise.resolve( response( uuids ) );
  };

  it( "shows results from the HTTP cache, then the latest", async ( ) => {
    let resolveLatest;
    const fromCache = answerFromCache( ["a", "b"] );
    inatjs.observations.search.mockImplementation( ( ...args ) => fromCache( ...args )
      ?? new Promise( resolve => { resolveLatest = resolve; } ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a", "b"] ) );
    expect( result.current.totalResults ).toEqual( 2 );
    await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 2 ) );

    await act( async ( ) => { resolveLatest( response( ["c", "a", "b"] ) ); } );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["c", "a", "b"] ) );
    expect( result.current.totalResults ).toEqual( 3 );
  } );

  it( "keeps the cached results when the latest can't be fetched", async ( ) => {
    const fromCache = answerFromCache( ["a", "b"] );
    inatjs.observations.search.mockImplementation( ( ...args ) => fromCache( ...args )
      ?? Promise.reject( new Error( "Network request failed" ) ) );
    // Another search, as the one above was fetched again from the network
    const { result } = renderExploreScroll( { ...PARAMS, taxon_id: 3 } );
    await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 2 ) );
    await waitFor( ( ) => expect( result.current.refreshFailed ).toBe( true ) );
    expect( uuidsOf( result ) ).toEqual( ["a", "b"] );
    expect( result.current.status ).toEqual( "success" );
  } );

  it( "never shows saved results with noCache", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result: firstResult, unmount } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( firstResult ) ).toEqual( ["a", "b"] ) );
    await flushPersistence( );
    unmount( );
    rendered = [];

    inatjs.observations.search.mockResolvedValue( response( ["c"] ) );
    const client = queryClient;
    const utils = renderHook(
      ( ) => useInfiniteExploreScroll( { params: PARAMS, enabled: true, noCache: true } ),
      {
        wrapper: ( { children } ) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    rendered.push( utils );
    expect( uuidsOf( utils.result ) ).toEqual( [] );
    await waitFor( ( ) => expect( uuidsOf( utils.result ) ).toEqual( ["c"] ) );
  } );

  it( "asks for a smaller first page, then full pages", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a", "b"] ) );
    expect( inatjs.observations.search.mock.calls[0][0] ).toMatchObject( { per_page: 12 } );

    await act( async ( ) => { result.current.fetchNextPage( ); } );
    await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 2 ) );
    expect( inatjs.observations.search.mock.calls[1][0] ).toMatchObject( { per_page: 20 } );
  } );

  it( "keeps page-numbered searches' pages all the same size", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a"] ) );
    const { result } = renderExploreScroll( { ...PARAMS, order_by: "votes" } );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a"] ) );
    expect( inatjs.observations.search.mock.calls[0][0] ).toMatchObject( { per_page: 20 } );
  } );

  it( "keeps the last search's results up while a new one loads, if asked", async ( ) => {
    let resolveSecond;
    inatjs.observations.search
      .mockResolvedValueOnce( response( ["a"] ) )
      .mockImplementationOnce( ( ) => new Promise( resolve => { resolveSecond = resolve; } ) );
    const client = queryClient;
    const utils = renderHook(
      ( { params } ) => useInfiniteExploreScroll( {
        params,
        enabled: true,
        noCache: true,
        keepPreviousResults: true,
      } ),
      {
        initialProps: { params: PARAMS },
        wrapper: ( { children } ) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    rendered.push( utils );
    const { result, rerender } = utils;
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a"] ) );

    rerender( { params: { ...PARAMS, taxon_id: 3 } } );
    await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 2 ) );
    expect( uuidsOf( result ) ).toEqual( ["a"] );
    expect( result.current.isPlaceholderData ).toBe( true );
    // The last search's count and bounds don't describe this one
    expect( result.current.totalResults ).toBeNull( );

    await act( async ( ) => { resolveSecond( response( ["b"] ) ); } );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["b"] ) );
    expect( result.current.isPlaceholderData ).toBe( false );
  } );

  it( "replaces the results when pulling to refresh works", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a", "b"] ) );

    inatjs.observations.search.mockResolvedValue( response( ["c"] ) );
    await act( ( ) => result.current.handlePullToRefresh( ) );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["c"] ) );
  } );

  it( "keeps the results shown when pulling to refresh fails", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a", "b"] ) );

    inatjs.observations.search.mockRejectedValue( new Error( "Network request failed" ) );
    await act( ( ) => result.current.handlePullToRefresh( ) );
    // Given the chance to re-render, it still shows the old results
    await flushPersistence( );
    expect( uuidsOf( result ) ).toEqual( ["a", "b"] );
    expect( result.current.status ).toEqual( "success" );
  } );

  describe( "with faved_by", ( ) => {
    const FAVED_PARAMS = { ...PARAMS, popular: true, faved_by: 7 };
    const fave = userId => ( { user_id: userId, vote_scope: null } );
    // Observations faved by user 7 only where listed
    const favedPage = ( ids, favedIds ) => ( {
      total_results: 1000,
      page: 1,
      per_page: 200,
      results: ids.map( id => ( {
        id,
        uuid: `obs-${id}`,
        votes: favedIds.includes( id )
          ? [fave( 3 ), fave( 7 )]
          : [fave( 3 ), { user_id: 7, vote_scope: "needs_id" }],
      } ) ),
    } );

    it( "shows only the viewer's faves, without sending faved_by", async ( ) => {
      inatjs.observations.search
        .mockResolvedValueOnce( favedPage( [10, 9], [9] ) )
        .mockResolvedValueOnce( favedPage( [8, 7], [7] ) )
        .mockResolvedValue( favedPage( [], [] ) );
      const { result } = renderExploreScroll( FAVED_PARAMS );
      await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 3 ) );
      await waitFor( ( ) => expect( result.current.hasNextPage ).toBe( false ) );
      expect( uuidsOf( result ) ).toEqual( ["obs-9", "obs-7"] );
      // Known once every popular observation has been checked
      expect( result.current.totalResults ).toEqual( 2 );
      const [apiParams] = inatjs.observations.search.mock.calls[0];
      expect( apiParams.faved_by ).toBeUndefined( );
      expect( apiParams ).toMatchObject( { popular: true, per_page: 200 } );
    } );

    it( "stops scanning after a batch of pages until more are asked for", async ( ) => {
      let nextId = 100000;
      inatjs.observations.search.mockImplementation( async ( ) => {
        nextId -= 2;
        return favedPage( [nextId + 1, nextId], [] );
      } );
      const { result } = renderExploreScroll( FAVED_PARAMS );
      await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 10 ) );
      await flushPersistence( );
      expect( inatjs.observations.search ).toHaveBeenCalledTimes( 10 );
      expect( result.current.totalResults ).toBeNull( );

      act( ( ) => result.current.fetchNextPage( ) );
      await waitFor( ( ) => expect( inatjs.observations.search ).toHaveBeenCalledTimes( 20 ) );
    } );
  } );
} );
