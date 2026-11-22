import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { useFocusEffect } from "@react-navigation/native";
import type { ApiObservationsUpdatesParams } from "api/types";
import NotificationsList from "components/Notifications/NotificationsList";
import React, { useCallback, useState } from "react";
import type { UserPojo } from "realmModels/User";
import {
  useInfiniteNotificationsScroll,
} from "sharedHooks";

interface Props {
  currentUser: UserPojo | null;
  notificationParams: ApiObservationsUpdatesParams;
  onRefresh?: ( ) => void;
}

const NotificationsContainer = ( {
  currentUser,
  notificationParams,
  onRefresh: onRefreshProp,
}: Props ) => {
  const { isConnected } = useNetInfo( );
  const [refreshing, setRefreshing] = useState( false );

  const {
    fetchNextPage,
    isError,
    isFetchingNextPage,
    isInitialLoading,
    showStillLoadingMessage,
    notifications,
    refetch,
  } = useInfiniteNotificationsScroll( notificationParams );

  useFocusEffect(
    useCallback( ( ) => {
      if ( isConnected && currentUser ) {
        refetch( );
      }
    }, [isConnected, currentUser, refetch] ),
  );

  const onRefresh = async () => {
    if ( currentUser ) {
      setRefreshing( true );
      await refetch();
      if ( typeof ( onRefreshProp ) === "function" ) onRefreshProp( );
      setRefreshing( false );
    }
  };

  const followingTabIsActive = notificationParams.observations_by === "following";

  return (
    <NotificationsList
      currentUser={currentUser}
      data={notifications}
      followingTabIsActive={followingTabIsActive}
      isError={isError}
      // Only the next page: the refetch on focus runs behind the cached list
      // and shouldn't look like it's still loading
      isFetching={isFetchingNextPage}
      isInitialLoading={isInitialLoading}
      isConnected={isConnected}
      showStillLoadingMessage={showStillLoadingMessage}
      onEndReached={fetchNextPage}
      reload={refetch}
      refreshing={refreshing}
      onRefresh={onRefresh}
    />
  );
};

export default NotificationsContainer;
