import { renderHook } from "@testing-library/react-native";
import useFetchPagesUpTo from "sharedHooks/useFetchPagesUpTo";

const render = props => renderHook( p => useFetchPagesUpTo( p ), { initialProps: props } );

describe( "useFetchPagesUpTo", ( ) => {
  const base = {
    enabled: true,
    loadedCount: 0,
    limit: 400,
    hasNextPage: true,
    isFetchingNextPage: false,
  };

  it( "fetches pages until the limit has loaded", ( ) => {
    const fetchNextPage = jest.fn( );
    const { rerender } = render( { ...base, fetchNextPage } );
    expect( fetchNextPage ).toHaveBeenCalledTimes( 1 );
    rerender( { ...base, fetchNextPage, isFetchingNextPage: true } );
    rerender( { ...base, fetchNextPage, loadedCount: 200 } );
    expect( fetchNextPage ).toHaveBeenCalledTimes( 2 );
    rerender( { ...base, fetchNextPage, loadedCount: 400 } );
    expect( fetchNextPage ).toHaveBeenCalledTimes( 2 );
  } );

  it( "doesn't fetch again when a page adds nothing", ( ) => {
    const fetchNextPage = jest.fn( );
    const { rerender } = render( { ...base, fetchNextPage, loadedCount: 200 } );
    rerender( {
      ...base, fetchNextPage, loadedCount: 200, isFetchingNextPage: true,
    } );
    rerender( { ...base, fetchNextPage, loadedCount: 200 } );
    expect( fetchNextPage ).toHaveBeenCalledTimes( 1 );
  } );

  it( "does nothing when disabled or without a next page", ( ) => {
    const fetchNextPage = jest.fn( );
    render( { ...base, fetchNextPage, enabled: false } );
    render( { ...base, fetchNextPage, hasNextPage: false } );
    expect( fetchNextPage ).not.toHaveBeenCalled( );
  } );
} );
