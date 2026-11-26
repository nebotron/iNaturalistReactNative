import { fetchIdentifiers, fetchObservers } from "api/observations";
import { IDENTIFIERS_TAB, OBSERVERS_TAB } from "appConstants/tabs";
import ExploreFlashList from "components/Explore/components/ExploreFlashList";
import type {
  ExploreBaseQueryParams,
} from "components/Explore/helpers/buildQueryParams";
import React, { useEffect } from "react";
import User from "realmModels/User";
import useInfiniteScroll from "sharedHooks/useInfiniteScroll";

export type UsersTab = typeof OBSERVERS_TAB | typeof IDENTIFIERS_TAB;

const TAB_CONFIG = {
  [OBSERVERS_TAB]: {
    queryKey: "exploreObservers",
    fetchUsers: fetchObservers,
    extraParams: {
      order_by: "observation_count",
      fields: {
        user: User.LIMITED_FIELDS,
      },
    },
  },
  [IDENTIFIERS_TAB]: {
    queryKey: "exploreIdentifiers",
    fetchUsers: fetchIdentifiers,
    extraParams: {
      fields: {
        identifications_count: true,
        user: User.LIMITED_FIELDS,
      },
    },
  },
};

interface Props {
  enabled: boolean;
  isConnected: boolean | null;
  params: ExploreBaseQueryParams;
  tab: UsersTab;
  // Total from the list's own first page, so the header needs no extra request
  onCount?: ( count: number ) => void;
  // See CustomFlashList
  scrollRestoreKey?: string;
}

const ExploreUsersView = ( {
  enabled,
  isConnected,
  params,
  tab,
  onCount,
  scrollRestoreKey,
}: Props ) => {
  const { queryKey, fetchUsers, extraParams } = TAB_CONFIG[tab];

  const {
    data,
    fetchNextPage,
    isFetchingNextPage,
    totalResults,
  } = useInfiniteScroll(
    queryKey,
    fetchUsers,
    {
      ...params,
      ...extraParams,
    },
    { enabled, persist: true },
  );

  useEffect( ( ) => {
    if ( onCount && typeof totalResults === "number" ) onCount( totalResults );
  }, [totalResults, onCount] );

  return (
    <ExploreFlashList
      canFetch={enabled}
      data={data}
      fetchNextPage={fetchNextPage}
      hideLoadingWheel={!isFetchingNextPage}
      isFetchingNextPage={isFetchingNextPage}
      isConnected={isConnected}
      layout="user"
      scrollRestoreKey={scrollRestoreKey}
      totalResults={totalResults}
    />
  );
};

export default ExploreUsersView;
