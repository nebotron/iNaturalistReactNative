import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import useInfiniteExploreScroll from "components/Explore/hooks/useInfiniteExploreScroll";
import inatjs from "inaturalistjs";
import React from "react";

jest.mock( "sharedHooks/useCurrentUser", ( ) => ( {
  __esModule: true,
  default: ( ) => null,
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

let queryClient;
const startApp = ( ) => {
  queryClient = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
};

let rendered = [];
const renderExploreScroll = ( ) => {
  const client = queryClient;
  const utils = renderHook(
    ( ) => useInfiniteExploreScroll( { params: PARAMS, enabled: true } ),
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

// Gives the hook the chance to re-render
const flushRenders = ( ) => act( async ( ) => {
  await new Promise( resolve => { setTimeout( resolve, 10 ); } );
} );

describe( "useInfiniteExploreScroll", ( ) => {
  beforeEach( ( ) => {
    startApp( );
    inatjs.observations.search.mockReset( );
  } );

  afterEach( ( ) => {
    // Unmounted, then cleared, or the queries' two-day garbage collection
    // timers would keep Jest from exiting
    rendered.forEach( utils => utils.unmount( ) );
    rendered = [];
    queryClient.clear( );
  } );

  it( "shows the results it fetched before leaving Explore without fetching again", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result: firstResult, unmount } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( firstResult ) ).toEqual( ["a", "b"] ) );
    unmount( );
    rendered = [];

    inatjs.observations.search.mockClear( );
    const { result } = renderExploreScroll( );
    expect( uuidsOf( result ) ).toEqual( ["a", "b"] );
    expect( result.current.totalResults ).toEqual( 2 );
    expect( inatjs.observations.search ).not.toHaveBeenCalled( );
  } );

  it( "asks for results the HTTP cache can keep", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a"] ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a"] ) );
    expect( inatjs.observations.search.mock.calls[0][0] ).not.toHaveProperty( "ttl" );
  } );

  it( "asks the API afresh when pulling to refresh", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a"] ) );
    const { result } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( result ) ).toEqual( ["a"] ) );

    inatjs.observations.search.mockClear( );
    await act( ( ) => result.current.handlePullToRefresh( ) );
    expect( inatjs.observations.search.mock.calls[0][0] ).toHaveProperty( "ttl", -1 );
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
    await flushRenders( );
    expect( uuidsOf( result ) ).toEqual( ["a", "b"] );
    expect( result.current.status ).toEqual( "success" );
  } );
} );
