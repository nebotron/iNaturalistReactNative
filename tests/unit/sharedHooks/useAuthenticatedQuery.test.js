import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "token" ) ),
  isLoggedIn: jest.fn( ( ) => Promise.resolve( false ) ),
} ) );

// Like a request made recently, every one marked to prefer the cache is
// answered from it
let mockCached = true;
const mockCacheFirst = new WeakSet( );
jest.mock( "sharedHelpers/httpCache", ( ) => ( {
  preferCachedResponse: signal => {
    mockCacheFirst.add( signal );
    return signal;
  },
  requireNetworkResponse: signal => signal,
  wasServedFromCache: signal => mockCached && mockCacheFirst.has( signal ),
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
  } );

  it( "shows cached results first, then replaces them with the latest", async ( ) => {
    const { result } = renderQuery( );
    await waitFor( ( ) => expect( result.current.data ).toEqual( "cached" ) );
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
