import { refresh } from "@react-native-community/netinfo";
import type { FlashListProps } from "@shopify/flash-list";
import {
  ActivityIndicator,
  Body3,
  CustomFlashList,
  CustomRefreshControl,
  InfiniteScrollLoadingWheel,
  OfflineNotice,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import UserList from "components/UserList/UserList";
import React, { useCallback, useState } from "react";
import type { ViewStyle } from "react-native";
import { useTranslation } from "sharedHooks";

interface Props<T> {
  canFetch?: boolean;
  contentContainerStyle?: ViewStyle;
  data: T[];
  fetchNextPage: ( ) => void;
  hideLoadingWheel: boolean;
  isFetchingNextPage: boolean;
  isConnected: boolean | null;
  keyExtractor?: FlashListProps<T>["keyExtractor"];
  layout?: "grid" | "user";
  numColumns?: number;
  // Turns on pull to refresh, which works with no results too
  onRefresh?: ( ) => Promise<void>;
  refreshAccessibilityLabel?: string;
  renderItem?: FlashListProps<T>["renderItem"];
  renderItemSeparator?: FlashListProps<T>["ItemSeparatorComponent"];
  scrollRestoreKey?: string;
  testID?: string;
  // Null while the count isn't known yet
  totalResults: number | null;
}

const ExploreFlashList = <T extends object, >( {
  canFetch,
  contentContainerStyle,
  data,
  fetchNextPage,
  hideLoadingWheel,
  isFetchingNextPage,
  isConnected,
  keyExtractor,
  layout,
  numColumns,
  onRefresh,
  refreshAccessibilityLabel,
  renderItem,
  renderItemSeparator,
  scrollRestoreKey,
  testID,
  totalResults,
}: Props<T> ) => {
  const { t } = useTranslation( );
  const [refreshing, setRefreshing] = useState( false );

  const handleRefresh = useCallback( async ( ) => {
    if ( !onRefresh ) return;
    setRefreshing( true );
    try {
      await onRefresh( );
    } finally {
      setRefreshing( false );
    }
  }, [onRefresh] );

  const refreshControl = onRefresh
    ? (
      <CustomRefreshControl
        accessibilityLabel={refreshAccessibilityLabel}
        onRefresh={handleRefresh}
        refreshing={refreshing}
      />
    )
    : undefined;

  const renderFooter = useCallback( ( ) => (
    <InfiniteScrollLoadingWheel
      hideLoadingWheel={hideLoadingWheel}
      layout={layout}
      explore
      isConnected={isConnected}
    />
  ), [hideLoadingWheel, layout, isConnected] );

  const renderLoading = useCallback( ( ) => {
    if ( totalResults === 0 ) {
      return (
        <Body3 className="align-center">{t( "No-results-found-try-different-search" )}</Body3> );
    }
    return ( <ActivityIndicator size={50} testID="ExploreFlashList.loading" /> );
  }, [totalResults, t] );

  const renderEmptyComponent = useCallback( ( ) => ( isConnected === false
    // Nothing cached to show, and nothing can load until back online. Checking
    // the connection again lets React Query fetch if it's back.
    ? (
      <View className="mt-[150px]">
        <OfflineNotice onPress={( ) => { refresh( ); }} />
      </View>
    )
    : (
      <View className="self-center mt-[150px] p-4">
        {canFetch
          ? (
            renderLoading()
          )
          : <Body3 className="align-center">{t( "No-results-found-try-different-search" )}</Body3>}
      </View>
    ) ), [canFetch, isConnected, renderLoading, t] );

  return layout === "user"
    ? (
      <UserList
        ListEmptyComponent={renderEmptyComponent( )}
        ListFooterComponent={renderFooter( )}
        contentContainerStyle={contentContainerStyle}
        users={data}
        onEndReached={fetchNextPage}
        refreshing={isFetchingNextPage}
        scrollRestoreKey={scrollRestoreKey}
      />
    )
    : (
      <CustomFlashList
        ItemSeparatorComponent={renderItemSeparator}
        ListEmptyComponent={renderEmptyComponent}
        ListFooterComponent={renderFooter}
        contentContainerStyle={contentContainerStyle}
        data={data}
        keyExtractor={keyExtractor}
        numColumns={numColumns}
        onEndReached={fetchNextPage}
        refreshControl={refreshControl}
        refreshing={isFetchingNextPage}
        renderItem={renderItem}
        scrollRestoreKey={scrollRestoreKey}
        testID={testID}
      />
    );
};

export default ExploreFlashList;
