import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( "token" ) ),
  isLoggedIn: jest.fn( ( ) => Promise.resolve( false ) ),
} ) );

// Like a search made recently, every request not marked to go to the network
// is answered from the cache
let mockCached = true;
const mockNetworkOnly = new WeakSet( );
jest.mock( "sharedHelpers/httpCache", ( ) => ( {
  preferNetworkResponse: signal => signal,
  requireNetworkResponse: signal => {
    mockNetworkOnly.add( signal );
    return signal;
  },
  wasServedFromCache: signal => mockCached && !mockNetworkOnly.has( signal ),
} ) );

// The network answers once the test lets it
let answerFromNetwork = ( ) => undefined;
const queryFunction = jest.fn( ( { signal } ) => ( mockCached
  && !mockNetworkOnly.has( signal )
  ? Promise.resolve( "cached" )
  : new Promise( resolve => {
    answerFromNetwork = ( ) => resolve( "latest" );
  } ) ) );

const renderQuery = ( ) => {
  const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
  const wrapper = ( { children } ) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    ( ) => useAuthenticatedQuery( ["test"], queryFunction, { enabled: true } ),
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
} );
