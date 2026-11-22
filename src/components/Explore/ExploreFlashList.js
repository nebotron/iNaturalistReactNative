// @flow
import { refresh } from "@react-native-community/netinfo";
import {
  ActivityIndicator, Body3, CustomFlashList, InfiniteScrollLoadingWheel, OfflineNotice,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import UserList from "components/UserList/UserList";
import type { Node } from "react";
import React, { useCallback } from "react";
import { useTranslation } from "sharedHooks";

type Props = {
  canFetch?: boolean,
  contentContainerStyle?: Object,
  data: Object[],
  fetchNextPage: boolean,
  hideLoadingWheel: boolean,
  isFetchingNextPage: boolean,
  isConnected: boolean,
  keyExtractor?: Function,
  layout?: string,
  numColumns?: number,
  renderItem?: Function,
  renderItemSeparator?: Function,
  scrollRestoreKey?: string,
  testID?: string,
  totalResults: number
};

const ExploreFlashList = ( {
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
  renderItem,
  renderItemSeparator,
  scrollRestoreKey,
  testID,
  totalResults,
}: Props ): Node => {
  const { t } = useTranslation( );

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
        ListEmptyComponent={renderEmptyComponent}
        ListFooterComponent={renderFooter}
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
        refreshing={isFetchingNextPage}
        renderItem={renderItem}
        scrollRestoreKey={scrollRestoreKey}
        testID={testID}
      />
    );
};

export default ExploreFlashList;
