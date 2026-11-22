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

  it( "shows the results it fetched before a restart without fetching again", async ( ) => {
    inatjs.observations.search.mockResolvedValue( response( ["a", "b"] ) );
    const { result: firstResult, unmount } = renderExploreScroll( );
    await waitFor( ( ) => expect( uuidsOf( firstResult ) ).toEqual( ["a", "b"] ) );
    await flushPersistence( );
    unmount( );
    rendered = [];
    queryClient.clear( );

    startApp( );
    inatjs.observations.search.mockClear( );
    const { result } = renderExploreScroll( );
    expect( uuidsOf( result ) ).toEqual( ["a", "b"] );
    expect( result.current.totalResults ).toEqual( 2 );
    expect( inatjs.observations.search ).not.toHaveBeenCalled( );
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
} );
