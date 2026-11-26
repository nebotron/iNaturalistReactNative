import { act, render, screen } from "@testing-library/react-native";
import CustomFlashList from "components/SharedComponents/FlashList/CustomFlashList";
import React from "react";
import useStore from "stores/useStore";

const mockScrollToOffset = jest.fn( );

// Stands in for FlashList so the test can drive its scroll and size callbacks
jest.mock( "@shopify/flash-list", ( ) => {
  const { View } = jest.requireActual( "react-native" );
  const MockReact = jest.requireActual( "react" );
  function FlashList( props ) {
    // A named function, not an arrow: babel hoisting the mock rejects the arrow
    // eslint-disable-next-line prefer-arrow-callback
    MockReact.useImperativeHandle( props.ref, function handle( ) {
      return { scrollToOffset: mockScrollToOffset };
    } );
    return MockReact.createElement( View, { ...props, ref: undefined, testID: "FlashList" } );
  }
  return { FlashList };
} );

const KEY = "explore:species:{}";

const renderList = ( props = {} ) => render(
  <CustomFlashList
    data={[]}
    renderItem={( ) => null}
    scrollRestoreKey={KEY}
    // eslint-disable-next-line react/jsx-props-no-spreading
    {...props}
  />,
);

const list = ( ) => screen.getByTestId( "FlashList" ).props;

const scrollTo = y => act( ( ) => list( ).onScroll( {
  nativeEvent: { contentOffset: { x: 0, y } },
} ) );

describe( "CustomFlashList scroll restoration", ( ) => {
  beforeEach( ( ) => {
    mockScrollToOffset.mockClear( );
    useStore.setState( { listScrollOffsets: {} } );
  } );

  it( "remembers where the list was scrolled to when it unmounts", ( ) => {
    const { unmount } = renderList( );
    scrollTo( 1200 );

    unmount( );

    expect( useStore.getState( ).listScrollOffsets[KEY] ).toBe( 1200 );
  } );

  it( "scrolls back there once the content is tall enough", ( ) => {
    useStore.setState( { listScrollOffsets: { [KEY]: 1200 } } );
    renderList( );

    act( ( ) => list( ).onContentSizeChange( 400, 600 ) );
    expect( mockScrollToOffset ).not.toHaveBeenCalled( );

    act( ( ) => list( ).onContentSizeChange( 400, 3000 ) );
    expect( mockScrollToOffset ).toHaveBeenCalledWith( { offset: 1200, animated: false } );
  } );

  it( "doesn't jump once the user has started scrolling", ( ) => {
    useStore.setState( { listScrollOffsets: { [KEY]: 1200 } } );
    renderList( );

    act( ( ) => list( ).onScrollBeginDrag( {
      nativeEvent: { contentOffset: { x: 0, y: 0 } },
    } ) );
    act( ( ) => list( ).onContentSizeChange( 400, 3000 ) );

    expect( mockScrollToOffset ).not.toHaveBeenCalled( );
  } );

  it( "keeps the saved offset if the list leaves before restoring it", ( ) => {
    useStore.setState( { listScrollOffsets: { [KEY]: 1200 } } );
    const { unmount } = renderList( );

    unmount( );

    expect( useStore.getState( ).listScrollOffsets[KEY] ).toBe( 1200 );
  } );

  it( "starts a list for a different search at the top", ( ) => {
    useStore.setState( { listScrollOffsets: { [KEY]: 1200 } } );
    renderList( { scrollRestoreKey: "explore:species:{\"taxon_id\":1}" } );

    act( ( ) => list( ).onContentSizeChange( 400, 3000 ) );

    expect( mockScrollToOffset ).not.toHaveBeenCalled( );
  } );

  it( "remembers nothing without a key", ( ) => {
    const { unmount } = renderList( { scrollRestoreKey: undefined } );
    scrollTo( 1200 );

    unmount( );

    expect( useStore.getState( ).listScrollOffsets ).toEqual( {} );
  } );
} );
