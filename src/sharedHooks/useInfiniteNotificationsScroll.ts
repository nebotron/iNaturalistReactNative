import { fetchObservationUpdates, fetchRemoteObservations } from "api/observations";
import type {
  ApiNotification,
  ApiObservation,
  ApiObservationsUpdatesParams,
  ApiOpts,
} from "api/types";
import flatten from "lodash/flatten";
import { RealmContext } from "providers/contexts";
import { useEffect, useMemo, useState } from "react";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import { useAuthenticatedInfiniteQuery, useCurrentUser } from "sharedHooks";

const { useRealm } = RealmContext;

const LOADING_TIMEOUT = 5000;

// Extends API response with data we need in this app
export interface Notification extends ApiNotification {
  resource?: ApiObservation;
  viewerOwnsResource?: boolean;
}

interface InfiniteNotificationsScrollResponse {
  fetchNextPage: ( ) => void;
  isError?: boolean;
  isFetching?: boolean;
  isInitialLoading?: boolean;
  showStillLoadingMessage: boolean;
  notifications: Notification[];
  refetch: ( ) => void;
}

const UPDATE_FIELDS = {
  comment_id: true,
  comment: {
    user: {
      login: true,
    },
  },
  created_at: true,
  id: true,
  identification_id: true,
  identification: {
    user: {
      login: true,
    },
  },
  notifier_type: true,
  resource_uuid: true,
  viewed: true,
};

const BASE_PARAMS: ApiObservationsUpdatesParams = {
  // observations_by: "owner",
  fields: UPDATE_FIELDS,
  per_page: 30,
  ttl: -1,
  page: 1,
};

async function fetchObsByUUIDs(
  uuids: string[],
  authOptions: ApiOpts,
  realm: Realm,
  options: {
    save?: boolean;
  } = {},
) {
  // TODO convert api/observations to TS
  const observations: ApiObservation[] | null = await fetchRemoteObservations(
    uuids,
    {
      fields: {
        ...Observation.ADVANCED_MODE_LIST_FIELDS,
        // Ensure login is fetched; ADVANCED_MODE_LIST_FIELDS only requests user.id,
        // which would otherwise override the login field via the spread above
        user: {
          ...Observation.ADVANCED_MODE_LIST_FIELDS.user,
          login: true,
        },
      },
    },
    authOptions,
  );
  if ( options.save ) {
    Observation.upsertRemoteObservations( observations, realm );
  }
  return observations;
}

// Shared with useUnviewedNotificationsCount, which prefetches this same
// query in the background when it sees the unviewed count go up.
export const getNotificationsQueryKey = (
  notificationParams: ApiObservationsUpdatesParams,
): string[] => ["useInfiniteNotificationsScroll", JSON.stringify( notificationParams )];

export async function fetchNotificationsPage(
  notificationParams: ApiObservationsUpdatesParams,
  pageParam: number,
  optsWithAuth: ApiOpts,
  realm: Realm,
  currentUserId?: number,
): Promise<Notification[]> {
  const params = { ...BASE_PARAMS, ...notificationParams, page: pageParam || 1 };

  const response: null | ApiNotification[] = await fetchObservationUpdates(
    params,
    optsWithAuth,
  );

  // Sometimes updates linger after notifiers that generated them have been deleted
  const updatesWithContent = response?.filter(
    update => update.comment || update.identification,
  ) || [];
  const obsUUIDs = updatesWithContent.map( obsUpdate => obsUpdate.resource_uuid );
  if ( obsUUIDs.length > 0 ) {
    const observations = await fetchObsByUUIDs(
      obsUUIDs,
      optsWithAuth,
      realm,
      { save: params.observations_by === "owner" },
    );
    if ( observations ) {
      return updatesWithContent.map( ( update: Notification ) => {
        const resource = observations.find(
          ( o: ApiObservation ) => o.uuid === update.resource_uuid,
        );
        update.resource = resource;
        update.viewerOwnsResource = resource?.user?.id === currentUserId;
        return update;
      } );
    }
  }

  return updatesWithContent;
}

const useInfiniteNotificationsScroll = (
  notificationParams: ApiObservationsUpdatesParams = {},
): InfiniteNotificationsScrollResponse => {
  const currentUser = useCurrentUser( );
  const realm = useRealm( );
  const [showStillLoadingMessage, setShowStillLoadingMessage] = useState( false );

  const queryKey = useMemo(
    () => getNotificationsQueryKey( notificationParams ),
    [notificationParams],
  );

  const {
    data,
    isFetching,
    isInitialLoading,
    isError,
    refetch,
    fetchNextPage,
  } = useAuthenticatedInfiniteQuery(
    queryKey,
    ( { pageParam }: { pageParam: number }, optsWithAuth: ApiOpts ) => fetchNotificationsPage(
      notificationParams,
      pageParam,
      optsWithAuth,
      realm,
      currentUser?.id,
    ),
    {
      getNextPageParam: ( lastPage, allPages ) => ( lastPage.length > 0
        ? allPages.length + 1
        : undefined ),
      enabled: !!( currentUser ),
    },
  );

  // After 5 seconds of loading, we add a "Still loading..." message to the UI
  useEffect( () => {
    // Reset if we get data
    if ( data !== undefined && !isFetching ) {
      setShowStillLoadingMessage( false );
      return undefined;
    }

    // Don't set timer if not loading
    if ( !isFetching ) {
      return undefined;
    }

    const timer = setTimeout( () => {
      if ( data === undefined && isFetching ) {
        setShowStillLoadingMessage( true );
      }
    }, LOADING_TIMEOUT );

    // eslint-disable-next-line consistent-return
    return () => clearTimeout( timer );
  }, [data, isFetching] );

  // Reset when user manually retries
  useEffect( () => {
    if ( isFetching ) {
      setShowStillLoadingMessage( false );
    }
  }, [isFetching] );

  // Stable sort: unviewed notifications float to the top, newest-first
  // within each group (the server already returns pages newest-first).
  const notifications = useMemo(
    ( ) => flatten( data?.pages ).sort(
      ( a: Notification, b: Notification ) => Number( a.viewed ) - Number( b.viewed ),
    ),
    [data],
  );

  return {
    refetch,
    isError,
    isFetching,
    isInitialLoading,
    showStillLoadingMessage,
    // Disable fetchNextPage if signed out
    fetchNextPage: currentUser
      ? fetchNextPage
      : ( ) => undefined,
    notifications,
  };
};

export default useInfiniteNotificationsScroll;
