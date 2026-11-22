import type { FlashListProps, FlashListRef, ViewToken } from "@shopify/flash-list";
import { FlashList } from "@shopify/flash-list";
import React, {
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { NativeScrollEvent, NativeSyntheticEvent, ViewabilityConfig } from "react-native";
import flashListTracker from "sharedHelpers/flashListPerformanceTracker";
import useStore from "stores/useStore";

const defaultViewabilityConfig: ViewabilityConfig = {
  minimumViewTime: 0,
  viewAreaCoveragePercentThreshold: 10,
  waitForInteraction: false,
};

// How long after mounting a saved scroll offset may still be restored, while
// the content it needs loads. Past that, jumping would surprise the user.
const RESTORE_WINDOW_MS = 5000;

type Props<T> = FlashListProps<T> & {
  ref?: React.Ref<FlashListRef<T>>;
  // Remembers where the list was scrolled to under this key and scrolls back
  // there when the list mounts again with it, e.g. after leaving a tab
  scrollRestoreKey?: string;
};

const CustomFlashList = <T, >( props: Props<T> ) => {
  const isFirstRender = useRef( true );
  const lastContentOffset = useRef( 0 );

  const scrollStartPosition = useRef( 0 );
  const scrollStartTime = useRef( 0 );
  const isUserScrolling = useRef( false );
  const ignoreInitialEvents = useRef( true );
  const fetchInProgress = useRef( false );

  const internalRef = useRef<FlashListRef<T> | null>( null );

  const {
    ref,
    onContentSizeChange,
    onMomentumScrollEnd,
    onScroll,
    onViewableItemsChanged,
    onEndReached,
    scrollRestoreKey,
    ...otherProps
  } = props;

  const setListScrollOffset = useStore( state => state.setListScrollOffset );
  // Offset waiting for enough content to scroll to, and until when it may be
  const pendingRestore = useRef<{ offset: number; until: number } | null>( null );

  useEffect( ( ) => {
    if ( !scrollRestoreKey ) return ( ) => undefined;
    const offset = useStore.getState( ).listScrollOffsets[scrollRestoreKey];
    pendingRestore.current = offset
      ? { offset, until: Date.now( ) + RESTORE_WINDOW_MS }
      : null;
    return ( ) => {
      // Never restored, so keep what was saved rather than the top of the list
      if ( !pendingRestore.current ) {
        setListScrollOffset( scrollRestoreKey, lastContentOffset.current );
      }
    };
  }, [scrollRestoreKey, setListScrollOffset] );

  const handleContentSizeChange = useCallback( ( width: number, height: number ) => {
    const pending = pendingRestore.current;
    if ( pending ) {
      if ( Date.now( ) > pending.until ) {
        pendingRestore.current = null;
      } else if ( height >= pending.offset ) {
        pendingRestore.current = null;
        lastContentOffset.current = pending.offset;
        internalRef.current?.scrollToOffset( { offset: pending.offset, animated: false } );
      }
    }
    onContentSizeChange?.( width, height );
  }, [onContentSizeChange] );

  useEffect( ( ) => {
    if ( isFirstRender.current ) {
      flashListTracker.reset( );
      isFirstRender.current = false;

      const timer = setTimeout( ( ) => {
        ignoreInitialEvents.current = false;
      }, 1000 );

      return ( ) => clearTimeout( timer );
    }
    return ( ) => undefined;
  }, [] );

  const handleViewableItemsChanged = useCallback(
    ( info: { viewableItems: ViewToken<T>[]; changed: ViewToken<T>[] } ) => {
      if ( info.viewableItems.length > 0 ) {
        flashListTracker.markItemsVisible( );
      }

      if ( onViewableItemsChanged ) {
        onViewableItemsChanged( info );
      }
    },
    [onViewableItemsChanged],
  );

  const handleScroll = useCallback(
    ( event: NativeSyntheticEvent<NativeScrollEvent> ) => {
      lastContentOffset.current = event.nativeEvent.contentOffset.y;

      if ( onScroll ) {
        onScroll( event );
      }
    },
    [onScroll],
  );

  const handleScrollBeginDrag = useCallback(
    ( event: NativeSyntheticEvent<NativeScrollEvent> ) => {
      // The user has scrolled since mounting, so don't jump them anywhere
      pendingRestore.current = null;
      if ( ignoreInitialEvents.current ) return;

      const { y } = event.nativeEvent.contentOffset;

      scrollStartPosition.current = y;
      scrollStartTime.current = Date.now( );
      isUserScrolling.current = true;

      flashListTracker.beginScrollEvent( y );
    },
    [],
  );

  const handleScrollEndDrag = useCallback(
    ( event: NativeSyntheticEvent<NativeScrollEvent> ) => {
      if ( ignoreInitialEvents.current || !isUserScrolling.current ) return;

      const { y } = event.nativeEvent.contentOffset;

      isUserScrolling.current = false;
      flashListTracker.endScrollEvent( y );

      fetchInProgress.current = true;
      flashListTracker.beginDataFetch( );
    },
    [],
  );

  const handleMomentumScrollEnd = useCallback(
    ( event: NativeSyntheticEvent<NativeScrollEvent> ) => {
      if ( onMomentumScrollEnd ) {
        onMomentumScrollEnd( event );
      }

      if ( isUserScrolling.current && !ignoreInitialEvents.current ) {
        const { y } = event.nativeEvent.contentOffset;
        isUserScrolling.current = false;
        flashListTracker.endScrollEvent( y );

        if ( !fetchInProgress.current ) {
          fetchInProgress.current = true;
          flashListTracker.beginDataFetch( );
        }
      }
    },
    [onMomentumScrollEnd],
  );

  const handleEndReached = useCallback( ( ) => {
    if ( ignoreInitialEvents.current ) return;

    if ( !fetchInProgress.current ) {
      fetchInProgress.current = true;
      flashListTracker.beginDataFetch( );
    }

    if ( onEndReached ) {
      onEndReached( );
    }
  }, [onEndReached] );

  // To be called when new data is received
  // This needs to be exposed so it can be called from parent component
  React.useImperativeHandle( ref, ( ) => {
    const flashListMethods = internalRef.current || {};

    return {
      ...flashListMethods,
      notifyDataFetched: ( itemsCount: number ) => {
        if ( fetchInProgress.current ) {
          flashListTracker.endDataFetch( itemsCount );
          fetchInProgress.current = false;
        } else {
          flashListTracker.beginDataFetch( );
          flashListTracker.endDataFetch( itemsCount );
        }
      },
    };
  } );

  const viewabilityConfig = {
    ...defaultViewabilityConfig,
    ...props.viewabilityConfig,
  };

  return (
    <FlashList
      ref={internalRef}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.2}
      onViewableItemsChanged={handleViewableItemsChanged}
      onContentSizeChange={handleContentSizeChange}
      onScroll={handleScroll}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEndDrag={handleScrollEndDrag}
      onMomentumScrollEnd={handleMomentumScrollEnd}
      viewabilityConfig={viewabilityConfig}
      // Fixes MOB-1464 where successful upload creates reordering issues and sometimes gaps
      // https://shopify.github.io/flash-list/docs/known-issues#3-data-re-ordering-can-cause-items-to-move
      maintainVisibleContentPosition={{ disabled: true }}
      // eslint-disable-next-line react/jsx-props-no-spreading
      {...otherProps}
    />
  );
};

export default CustomFlashList;
