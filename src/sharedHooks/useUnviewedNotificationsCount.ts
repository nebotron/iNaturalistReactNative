import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import type { ApiObservationsUpdatesParams, ApiOpts } from "api/types";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { prefetchImageData } from "components/SharedComponents/CachedImage";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useRef, useState,
} from "react";
import { AppState, Image } from "react-native";
import Photo from "realmModels/Photo";
import useStore from "stores/useStore";

import useAuthenticatedQuery from "./useAuthenticatedQuery";
import useCurrentUser from "./useCurrentUser";
import type { Notification } from "./useInfiniteNotificationsScroll";
import {
  fetchNotificationsPage,
  getNextNotificationsPageParam,
  getNotificationsQueryKey,
} from "./useInfiniteNotificationsScroll";

const { useRealm } = RealmContext;

const TAB_PARAMS: Record<"owner" | "following", ApiObservationsUpdatesParams> = {
  owner: { observations_by: "owner" },
  following: { observations_by: "following" },
};

const NOTIFICATIONS_COUNT_KEY = "notificationsCount";

// The server marks every update on an observation viewed at once. Mirror that
// in the cached notification lists and take the same updates off the cached
// unviewed counts, so the green highlights and the red dots on the tab bar and
// tab headers clear together instead of the dots waiting on a refetch.
export const markObservationNotificationsViewedLocally = (
  queryClient: QueryClient,
  resourceUuid: string,
) => {
  const cleared: Record<string, Set<number>> = { owner: new Set( ), following: new Set( ) };
  queryClient.getQueriesData<InfiniteData<Notification[]>>(
    { queryKey: ["useInfiniteNotificationsScroll"] },
  ).forEach( ( [queryKey, data] ) => {
    const tab = JSON.parse( String( queryKey[1] ) ).observations_by;
    data?.pages.flat( ).forEach( n => {
      if ( n.resource_uuid === resourceUuid && !n.viewed ) cleared[tab]?.add( n.id );
    } );
  } );

  queryClient.setQueriesData<InfiniteData<Notification[]>>(
    { queryKey: ["useInfiniteNotificationsScroll"] },
    data => data && {
      ...data,
      pages: data.pages.map( page => page.map( n => (
        n.resource_uuid === resourceUuid
          ? { ...n, viewed: true }
          : n
      ) ) ),
    },
  );

  Object.entries( cleared ).forEach( ( [tab, ids] ) => {
    if ( ids.size === 0 ) return;
    const queryKey = [NOTIFICATIONS_COUNT_KEY, tab];
    // A count request already in flight started before this observation was
    // marked viewed, and would put the stale number back when it lands
    // (cancelling reverts it asynchronously, so write only after that)
    queryClient.cancelQueries( { queryKey } ).then( ( ) => {
      queryClient.setQueryData<number>(
        queryKey,
        count => ( typeof count === "number"
          ? Math.max( 0, count - ids.size )
          : count ),
      );
    } );
  } );
};

type Tab = "owner" | "following";

// Long enough that a list preloaded behind the tab dot is still there when the
// user gets round to opening it; nothing else observes it until they do.
const PRELOADED_LIST_GC_TIME = 24 * 60 * 60 * 1000;
// The dot waits on the preload, so don't let a stalled image hold it back
const MEDIA_PRELOAD_TIMEOUT = 15000;

const prefetchNotificationMedia = ( notifications: Notification[] ) => {
  const thumbnails: string[] = [];
  const largePhotos: string[] = [];
  notifications.forEach( notification => {
    const url = notification.resource?.observation_photos?.[0]?.photo?.url;
    if ( !url ) return;
    thumbnails.push( url );
    // Only what the user is likely to open: ObsDetails draws the large size
    const largePhoto = Photo.displayLargePhoto( url );
    if ( !notification.viewed && largePhoto ) largePhotos.push( largePhoto );
  } );
  const downloads = Promise.allSettled( [
    thumbnails.length > 0
      ? prefetchImageData( thumbnails )
      : null,
    ...[...new Set( largePhotos )].map( url => Image.prefetch( url ) ),
  ] );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race( [
    downloads,
    new Promise( resolve => { timeout = setTimeout( resolve, MEDIA_PRELOAD_TIMEOUT ); } ),
  ] ).finally( ( ) => clearTimeout( timeout ) );
};

interface Options {
  // Load each tab's list, its observations and their photos before reporting
  // the tab as having unviewed notifications (ownerReady / followingReady), so
  // the dot never leads to a spinner. Only the tab bar icon asks for this.
  preload?: boolean;
}

const useUnviewedNotificationsCount = ( { preload = false }: Options = {} ) => {
  const currentUser = useCurrentUser( );
  const realm = useRealm( );
  const queryClient = useQueryClient( );
  const observationMarkedAsViewedAt = useStore( state => state.observationMarkedAsViewedAt );
  // The unviewed count each tab's cached list is known to cover. A count above
  // it means there are notifications the cache hasn't loaded yet.
  const [preloadedCounts, setPreloadedCounts] = useState<Partial<Record<Tab, number>>>( {} );
  const preloading = useRef<Partial<Record<Tab, boolean>>>( {} );

  const preloadTab = useCallback( async ( tab: Tab, count: number ) => {
    preloading.current[tab] = true;
    try {
      const params = TAB_PARAMS[tab];
      const apiToken = await getJWT( );
      // getJWT returns null when the token can't be refreshed (e.g. in the
      // background). Fetching without it just 401s and caches an empty page.
      if ( !apiToken ) return;
      const data = await queryClient.fetchInfiniteQuery( {
        // realm is a stable context value, deliberately kept out of the key so
        // this matches the query key used in useInfiniteNotificationsScroll
        // eslint-disable-next-line @tanstack/query/exhaustive-deps
        queryKey: [...getNotificationsQueryKey( params ), undefined, currentUser],
        queryFn: ( { pageParam }: { pageParam: number } ) => fetchNotificationsPage(
          params,
          pageParam,
          { api_token: apiToken },
          realm,
          currentUser?.id,
        ),
        initialPageParam: 1,
        getNextPageParam: getNextNotificationsPageParam,
        gcTime: PRELOADED_LIST_GC_TIME,
      } );
      await prefetchNotificationMedia( data.pages[0] || [] );
    } catch {
      // Still show the dot: the user should hear about new notifications even
      // when the network won't let us load them ahead of time
    } finally {
      preloading.current[tab] = false;
    }
    setPreloadedCounts( counts => ( { ...counts, [tab]: count } ) );
  }, [queryClient, realm, currentUser] );

  const { data: ownerUnviewedCount, refetch: refetchOwner } = useAuthenticatedQuery(
    [NOTIFICATIONS_COUNT_KEY, "owner"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, requireLoggedIn: true },
  );

  const { data: followingUnviewedCount, refetch: refetchFollowing } = useAuthenticatedQuery(
    [NOTIFICATIONS_COUNT_KEY, "following"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "following" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, requireLoggedIn: true },
  );

  const refetch = useCallback( ( ) => {
    refetchOwner( );
    refetchFollowing( );
  }, [refetchOwner, refetchFollowing] );

  useEffect( ( ) => {
    if ( currentUser ) refetch( );
  }, [observationMarkedAsViewedAt, currentUser, refetch] );

  // No polling: the counts refresh when the app comes back to the foreground,
  // and callers refetch on focusing the Notifications tab.
  useEffect( ( ) => {
    const subscription = AppState.addEventListener( "change", state => {
      if ( state === "active" && currentUser ) refetch( );
    } );
    return ( ) => subscription.remove( );
  }, [currentUser, refetch] );

  useEffect( ( ) => {
    if ( !preload ) return;
    ( [
      ["owner", ownerUnviewedCount],
      ["following", followingUnviewedCount],
    ] as [Tab, unknown][] ).forEach( ( [tab, count] ) => {
      const preloadedCount = preloadedCounts[tab];
      if (
        typeof count !== "number"
        || count === preloadedCount
        || preloading.current[tab]
      ) return;
      if ( count === 0 || ( preloadedCount !== undefined && count < preloadedCount ) ) {
        // Fewer unviewed than the cache already covers: viewing one doesn't
        // need anything new loaded
        setPreloadedCounts( counts => ( { ...counts, [tab]: count } ) );
      } else if ( preloadedCount === undefined || count > preloadedCount ) {
        preloadTab( tab, count );
      }
    } );
  }, [preload, ownerUnviewedCount, followingUnviewedCount, preloadedCounts, preloadTab] );

  const isReady = ( tab: Tab, count: unknown ) => {
    const preloadedCount = preloadedCounts[tab];
    return typeof count === "number" && preloadedCount !== undefined && count <= preloadedCount;
  };

  return {
    // undefined while the initial fetch is still in flight, so callers can
    // distinguish "not loaded yet" from "loaded, zero unviewed"
    ownerUnviewedCount: ownerUnviewedCount as number | undefined,
    followingUnviewedCount: followingUnviewedCount as number | undefined,
    ownerReady: isReady( "owner", ownerUnviewedCount ),
    followingReady: isReady( "following", followingUnviewedCount ),
    refetch,
  };
};

export default useUnviewedNotificationsCount;
