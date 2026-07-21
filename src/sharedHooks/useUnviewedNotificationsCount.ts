import { useQueryClient } from "@tanstack/react-query";
import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import type { ApiObservationsUpdatesParams, ApiOpts } from "api/types";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useRef,
} from "react";
import useStore from "stores/useStore";

import useAuthenticatedQuery from "./useAuthenticatedQuery";
import useCurrentUser from "./useCurrentUser";
import {
  fetchNotificationsPage,
  getNotificationsQueryKey,
} from "./useInfiniteNotificationsScroll";

const { useRealm } = RealmContext;

// Poll infrequently in the background; callers can force an immediate
// refetch (e.g. on focusing the Notifications tab) via the returned refetch.
const REFETCH_INTERVAL = 300_000;

const TAB_PARAMS: Record<"owner" | "following", ApiObservationsUpdatesParams> = {
  owner: { observations_by: "owner" },
  following: { observations_by: "following" },
};

const useUnviewedNotificationsCount = () => {
  const currentUser = useCurrentUser( );
  const realm = useRealm( );
  const queryClient = useQueryClient( );
  const observationMarkedAsViewedAt = useStore( state => state.observationMarkedAsViewedAt );
  // Tracks previous counts so we only prefetch when a background poll
  // reveals *new* unviewed notifications, not on initial mount.
  const prevCounts = useRef<{ owner?: number; following?: number }>( {} );

  const prefetchIfIncreased = useCallback( async ( tab: "owner" | "following", count?: number ) => {
    const prevCount = prevCounts.current[tab];
    prevCounts.current[tab] = count;
    if ( count === undefined || prevCount === undefined || count <= prevCount ) return;

    const params = TAB_PARAMS[tab];
    const apiToken = await getJWT( );
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
    ["notificationsCount", "owner"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, refetchInterval: REFETCH_INTERVAL, requireLoggedIn: true },
  );

  const { data: followingUnviewedCount, refetch: refetchFollowing } = useAuthenticatedQuery(
    ["notificationsCount", "following"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "following" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, refetchInterval: REFETCH_INTERVAL, requireLoggedIn: true },
  );

  const refetch = useCallback( ( ) => {
    refetchOwner( );
    refetchFollowing( );
  }, [refetchOwner, refetchFollowing] );

  useEffect( ( ) => {
    if ( currentUser ) refetch( );
  }, [observationMarkedAsViewedAt, currentUser, refetch] );

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
