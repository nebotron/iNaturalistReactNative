import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "token" ) ),
  isLoggedIn: jest.fn( ( ) => Promise.resolve( false ) ),
} ) );

// Like a request made recently, every one marked to prefer the cache is
// answered from it
let mockCached = true;
// Whether the cached response was fetched too recently to fetch again
let mockCachedRecently = false;
const mockCacheFirst = new WeakSet( );
jest.mock( "sharedHelpers/httpCache", ( ) => ( {
  preferCachedResponse: signal => {
    mockCacheFirst.add( signal );
    return signal;
  },
  requireNetworkResponse: signal => signal,
  RECENT_RESULTS_MS: 10 * 60 * 1000,
  shouldFetchLatest: signal => mockCached && !mockCachedRecently && mockCacheFirst.has( signal ),
} ) );

// The network answers once the test lets it
let answerFromNetwork = ( ) => undefined;
const queryFunction = jest.fn( ( { signal } ) => ( mockCached
  && mockCacheFirst.has( signal )
  ? Promise.resolve( "cached" )
  : new Promise( resolve => {
    answerFromNetwork = ( ) => resolve( "latest" );
  } ) ) );

const renderQuery = ( options = {} ) => {
  const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
  const wrapper = ( { children } ) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ( ) => useAuthenticatedQuery( ["test"], queryFunction, { enabled: true, ...options } ),
    { wrapper },
  );
};

describe( "useAuthenticatedQuery", ( ) => {
  beforeEach( ( ) => {
    queryFunction.mockClear( );
    mockCached = true;
    mockCachedRecently = false;
  } );

  it( "shows cached results first, then replaces them with the latest", async ( ) => {
    const { result } = renderQuery( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "cached" ) );
    await waitFor( ( ) => expect( queryFunction ).toHaveBeenCalledTimes( 2 ) );
    answerFromNetwork( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "latest" ) );
  } );

  it( "doesn't fetch the latest when the cached results are recent", async ( ) => {
    mockCachedRecently = true;
    const { result } = renderQuery( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "cached" ) );
    await act( async ( ) => { await new Promise( resolve => { setTimeout( resolve, 50 ); } ); } );
    expect( queryFunction ).toHaveBeenCalledTimes( 1 );
  } );

  it( "goes to the network when refetching results already shown", async ( ) => {
    mockCachedRecently = true;
    const { result } = renderQuery( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "cached" ) );
    act( ( ) => { result.current.refetch( ); } );
    await waitFor( ( ) => expect( queryFunction ).toHaveBeenCalledTimes( 2 ) );
    answerFromNetwork( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "latest" ) );
  } );

  it( "fetches once when the network answers", async ( ) => {
    mockCached = false;
    const { result } = renderQuery( );
    await waitFor( ( ) => expect( queryFunction ).toHaveBeenCalledTimes( 1 ) );
    answerFromNetwork( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "latest" ) );
    expect( queryFunction ).toHaveBeenCalledTimes( 1 );
  } );

  it( "goes to the network first without cacheFirst", async ( ) => {
    const { result } = renderQuery( { cacheFirst: false } );
    await waitFor( ( ) => expect( queryFunction ).toHaveBeenCalledTimes( 1 ) );
    answerFromNetwork( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "latest" ) );
    expect( queryFunction ).toHaveBeenCalledTimes( 1 );
  } );
} );
