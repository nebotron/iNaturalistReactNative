import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react-native";
import {
  ExcludedSavedSearchError,
  resolveExcludedSpeciesIds,
} from "components/Explore/helpers/excludedSpecies";
import useExcludedSpecies from "components/Explore/hooks/useExcludedSpecies";
import React from "react";
import useStore from "stores/useStore";

jest.mock( "components/Explore/helpers/excludedSpecies", ( ) => ( {
  ...jest.requireActual( "components/Explore/helpers/excludedSpecies" ),
  resolveExcludedSpeciesIds: jest.fn( ),
} ) );

jest.mock( "components/LoginSignUp/AuthenticationService", ( ) => ( {
  getJWT: jest.fn( ( ) => Promise.resolve( null ) ),
} ) );

const SEARCH = { filters: { excludeSpeciesInSavedSearch: "Seen by me" } };

// Each render stands in for Explore mounting again, e.g. after Audio ID
const renderExcludedSpecies = ( { offline, searchCount = 0 } ) => {
  const client = new QueryClient( { defaultOptions: { queries: { retry: false } } } );
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
    useStore.setState( { excludedSpeciesIds: {} } );
    resolveExcludedSpeciesIds.mockReset( );
  } );

  it( "applies the species resolved earlier when they can't be resolved offline", async ( ) => {
    resolveExcludedSpeciesIds.mockResolvedValueOnce( [1, 2, 3] );
    const view = renderExcludedSpecies( { offline: false } );
    await waitFor( ( ) => expect( view.result.current.ids ).toEqual( [1, 2, 3] ) );
    view.unmount( );

    resolveExcludedSpeciesIds.mockRejectedValueOnce(
      new ExcludedSavedSearchError( "offline", "Seen by me" ),
    );
    const { result } = renderExcludedSpecies( { offline: true } );
    await waitFor( ( ) => expect( result.current.ids ).toEqual( [1, 2, 3] ) );
    expect( result.current.error ).toBeNull( );
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
