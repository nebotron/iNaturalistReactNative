import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import type { ApiObservationsUpdatesParams, ApiOpts } from "api/types";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useRef,
} from "react";
import { AppState } from "react-native";
import useStore from "stores/useStore";

import useAuthenticatedQuery from "./useAuthenticatedQuery";
import useCurrentUser from "./useCurrentUser";
import type { Notification } from "./useInfiniteNotificationsScroll";
import {
  fetchNotificationsPage,
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

const useUnviewedNotificationsCount = () => {
  const currentUser = useCurrentUser( );
  const realm = useRealm( );
  const queryClient = useQueryClient( );
  const observationMarkedAsViewedAt = useStore( state => state.observationMarkedAsViewedAt );
  // Tracks previous counts so we only prefetch when a refetch reveals *new*
  // unviewed notifications, not on initial mount.
  const prevCounts = useRef<{ owner?: number; following?: number }>( {} );
  const prefetchIfIncreased = useCallback( async ( tab: "owner" | "following", count?: number ) => {
    const prevCount = prevCounts.current[tab];
    prevCounts.current[tab] = count;
    if ( count === undefined || prevCount === undefined || count <= prevCount ) return;

    const params = TAB_PARAMS[tab];
    const apiToken = await getJWT( );
    // getJWT returns null when the token can't be refreshed (e.g. in the
    // background). Prefetching without it just makes an unauthenticated
    // request that 401s and caches an empty page.
    if ( !apiToken ) return;
    queryClient.prefetchInfiniteQuery( {
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
    } );
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
    prefetchIfIncreased( "owner", ownerUnviewedCount as number | undefined );
  }, [ownerUnviewedCount, prefetchIfIncreased] );

  useEffect( ( ) => {
    prefetchIfIncreased( "following", followingUnviewedCount as number | undefined );
  }, [followingUnviewedCount, prefetchIfIncreased] );

  return {
    // undefined while the initial fetch is still in flight, so callers can
    // distinguish "not loaded yet" from "loaded, zero unviewed"
    ownerUnviewedCount: ownerUnviewedCount as number | undefined,
    followingUnviewedCount: followingUnviewedCount as number | undefined,
    refetch,
  };
};

export default useUnviewedNotificationsCount;
