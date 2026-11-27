import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import {
  ExcludedSavedSearchError,
  resolveExcludedSpeciesIds,
} from "components/Explore/helpers/excludedSpecies";
import useExcludedSpecies from "components/Explore/hooks/useExcludedSpecies";
import React from "react";
import {
  clearPersistedQueries,
  persistQueries,
} from "sharedHelpers/persistedQueries";

jest.mock( "components/Explore/helpers/excludedSpecies", ( ) => ( {
  ...jest.requireActual( "components/Explore/helpers/excludedSpecies" ),
  resolveExcludedSpeciesIds: jest.fn( ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( null ) ),
} ) );

const SEARCH = { filters: { excludeSpeciesInSavedSearch: "Seen by me" } };

// Each render stands in for the app restarting and Explore mounting again:
// nothing is in memory, and only what was written to disk remains
let stopPersisting;
const renderExcludedSpecies = ( { offline, searchCount = 0 } ) => {
  stopPersisting?.( );
  const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
  stopPersisting = persistQueries( client, { writeDelayMs: 0 } );
  return renderHook(
    ( ) => useExcludedSpecies( SEARCH, { searchCount, offline, currentUserId: 1 } ),
    {
      wrapper: ( { children } ) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
};

describe( "useExcludedSpecies", ( ) => {
  beforeEach( ( ) => {
    clearPersistedQueries( );
    resolveExcludedSpeciesIds.mockReset( );
  } );

  afterEach( ( ) => {
    stopPersisting?.( );
    stopPersisting = undefined;
  } );

  it( "applies the species resolved earlier when they can't be resolved offline", async ( ) => {
    resolveExcludedSpeciesIds.mockResolvedValueOnce( [1, 2, 3] );
    const view = renderExcludedSpecies( { offline: false } );
    await waitFor( ( ) => expect( view.result.current.ids ).toEqual( [1, 2, 3] ) );
    // Lets the write to disk, on a timer, happen
    await new Promise( resolve => { setTimeout( resolve, 10 ); } );
    view.unmount( );

    resolveExcludedSpeciesIds.mockRejectedValueOnce(
      new ExcludedSavedSearchError( "offline", "Seen by me" ),
    );
    const { result } = renderExcludedSpecies( { offline: true } );
    await waitFor( ( ) => expect( result.current.ids ).toEqual( [1, 2, 3] ) );
    expect( result.current.error ).toBeNull( );
  } );

  it( "resolves them again when the search is applied again", async ( ) => {
    resolveExcludedSpeciesIds.mockResolvedValueOnce( [1, 2, 3] );
    const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
    const { result, rerender } = renderHook(
      ( { searchCount } ) => useExcludedSpecies( SEARCH, {
        searchCount, offline: false, currentUserId: 1,
      } ),
      {
        initialProps: { searchCount: 0 },
        wrapper: ( { children } ) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await waitFor( ( ) => expect( result.current.ids ).toEqual( [1, 2, 3] ) );

    resolveExcludedSpeciesIds.mockResolvedValueOnce( [4] );
    rerender( { searchCount: 1 } );
    // Not the old ones while the new ones load
    expect( result.current.ids ).toBeUndefined( );
    await waitFor( ( ) => expect( result.current.ids ).toEqual( [4] ) );
  } );

  it( "reports the error offline when nothing was resolved earlier", async ( ) => {
    resolveExcludedSpeciesIds.mockRejectedValueOnce(
      new ExcludedSavedSearchError( "offline", "Seen by me" ),
    );
    const { result } = renderExcludedSpecies( { offline: true } );
    await waitFor( ( ) => expect( result.current.error ).toBeInstanceOf(
      ExcludedSavedSearchError,
    ) );
    expect( result.current.ids ).toBeUndefined( );
  } );

  it( "still reports a saved search that's gone", async ( ) => {
    resolveExcludedSpeciesIds.mockResolvedValueOnce( [1, 2, 3] );
    const view = renderExcludedSpecies( { offline: false } );
    await waitFor( ( ) => expect( view.result.current.ids ).toEqual( [1, 2, 3] ) );
    // Lets the write to disk, on a timer, happen
    await new Promise( resolve => { setTimeout( resolve, 10 ); } );
    view.unmount( );

    resolveExcludedSpeciesIds.mockRejectedValueOnce(
      new ExcludedSavedSearchError( "missing", "Seen by me" ),
    );
    const { result } = renderExcludedSpecies( { offline: false } );
    await waitFor( ( ) => expect( result.current.error ).toBeInstanceOf(
      ExcludedSavedSearchError,
    ) );
    expect( result.current.ids ).toBeUndefined( );
  } );
} );
