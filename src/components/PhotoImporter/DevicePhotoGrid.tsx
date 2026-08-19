import { FlashList } from "@shopify/flash-list";
import type { ComponentProps, ReactElement } from "react";
import React, { useCallback, useEffect, useRef } from "react";
import { PixelRatio } from "react-native";
import {
  prefetchDeviceImageThumbnails,
  prioritizeDeviceImageThumbnails,
} from "sharedHelpers/useDeviceImageThumbnail";

type ContentStyle = ComponentProps<typeof FlashList>["contentContainerStyle"];

export interface DevicePhotoGridItem {
  id: string;
  type: "header" | "photo";
}

interface Props<T extends DevicePhotoGridItem> {
  items: T[];
  numColumns: number;
  // Laid-out width of one cell, used to size thumbnails and estimate rows
  itemWidth: number;
  renderHeader: ( item: T ) => ReactElement | null;
  renderPhoto: ( item: T ) => ReactElement | null;
  // Device photo uri for an item, used to warm thumbnails around the viewport
  getPhotoUri?: ( item: T ) => string | undefined;
  onEndReached?: ( ) => void;
  extraData?: unknown;
  contentContainerStyle?: ContentStyle;
}

// How far outside the viewport thumbnails are generated ahead of time. Ahead
// covers the usual downward scroll; behind covers scrolling back up, which is
// where previews used to appear to have "unloaded".
const PREFETCH_AHEAD = 30;
const PREFETCH_BEHIND = 18;

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 10 };

// A sectioned grid of device photos: full-width headers followed by square
// photo cells. Shared by the photo picker and the unfavorited-photo cleanup
// screen so both get the same virtualization and thumbnail prefetching.
const DevicePhotoGrid = <T extends DevicePhotoGridItem>( {
  items,
  numColumns,
  itemWidth,
  renderHeader,
  renderPhoto,
  getPhotoUri,
  onEndReached,
  extraData,
  contentContainerStyle,
}: Props<T> ) => {
  // Read through a ref so the viewability callback stays stable; FlashList
  // treats a changed onViewableItemsChanged as a fresh viewability config.
  const prefetchRef = useRef( { items, getPhotoUri, maxPixel: 0 } );
  useEffect( ( ) => {
    prefetchRef.current = {
      items,
      getPhotoUri,
      maxPixel: PixelRatio.getPixelSizeForLayoutSize( itemWidth || 128 ),
    };
  }, [items, getPhotoUri, itemWidth] );

  const onViewableItemsChanged = useCallback( ( { viewableItems }: {
    viewableItems: { index: number | null }[];
  } ) => {
    const { items: all, getPhotoUri: photoUri, maxPixel } = prefetchRef.current;
    if ( !photoUri || viewableItems.length === 0 ) return;
    const indices = viewableItems
      .map( token => token.index )
      .filter( ( index ): index is number => typeof index === "number" );
    if ( indices.length === 0 ) return;
    const first = Math.min( ...indices );
    const last = Math.max( ...indices );
    const uriAt = ( index: number ) => {
      const item = all[index];
      return item
        ? photoUri( item )
        : undefined;
    };

    // Whatever is on screen goes first, ahead of every cell the grid mounted
    // below the fold and ahead of every prefetch.
    const visible: string[] = [];
    for ( let i = first; i <= last; i += 1 ) {
      const uri = uriAt( i );
      if ( uri ) visible.push( uri );
    }
    prioritizeDeviceImageThumbnails( visible, maxPixel );

    const uris: string[] = [];
    // Enqueued least-urgent first: the queue is LIFO, so the photos just off
    // the leading edge of the viewport are generated first.
    const push = ( index: number ) => {
      const uri = uriAt( index );
      if ( uri ) uris.push( uri );
    };
    for ( let i = Math.max( 0, first - PREFETCH_BEHIND ); i < first; i += 1 ) push( i );
    for ( let i = Math.min( all.length - 1, last + PREFETCH_AHEAD ); i > last; i -= 1 ) push( i );
    prefetchDeviceImageThumbnails( uris, maxPixel );
  }, [] );

  const renderItem = useCallback( ( { item }: { item: T } ) => ( item.type === "header"
    ? renderHeader( item )
    : renderPhoto( item ) ), [renderHeader, renderPhoto] );

  const overrideItemLayout = useCallback( (
    layout: { span?: number },
    item: T,
  ) => {
    if ( item.type === "header" ) {
      layout.span = numColumns;
    }
  }, [numColumns] );

  return (
    <FlashList
      data={items}
      numColumns={numColumns}
      renderItem={renderItem}
      keyExtractor={item => item.id}
      getItemType={item => item.type}
      overrideItemLayout={overrideItemLayout}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      estimatedItemSize={itemWidth}
      extraData={extraData}
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={VIEWABILITY_CONFIG}
      contentContainerStyle={contentContainerStyle}
      // Render well past the viewport so cells are already mounted (and their
      // thumbnails requested) by the time they scroll into view.
      drawDistance={4000}
    />
  );
};

export default DevicePhotoGrid;
