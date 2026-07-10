import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import type { ApiOpts } from "api/types";
import { useCallback, useEffect } from "react";
import useStore from "stores/useStore";

import useAuthenticatedQuery from "./useAuthenticatedQuery";
import useCurrentUser from "./useCurrentUser";

// Poll infrequently in the background; callers can force an immediate
// refetch (e.g. on focusing the Notifications tab) via the returned refetch.
const REFETCH_INTERVAL = 300_000;

const useUnviewedNotificationsCount = () => {
  const currentUser = useCurrentUser( );
  const observationMarkedAsViewedAt = useStore( state => state.observationMarkedAsViewedAt );

  const { data: ownerUnviewedCount, refetch: refetchOwner } = useAuthenticatedQuery(
    ["notificationsCount", "owner"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, refetchInterval: REFETCH_INTERVAL },
  );

  const { data: followingUnviewedCount, refetch: refetchFollowing } = useAuthenticatedQuery(
    ["notificationsCount", "following"],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "following" },
      optsWithAuth,
    ),
    { enabled: !!currentUser, refetchInterval: REFETCH_INTERVAL },
  );

  const refetch = useCallback( ( ) => {
    refetchOwner( );
    refetchFollowing( );
  }, [refetchOwner, refetchFollowing] );

  useEffect( ( ) => {
    if ( currentUser ) refetch( );
  }, [observationMarkedAsViewedAt, currentUser, refetch] );

  return {
    // undefined while the initial fetch is still in flight, so callers can
    // distinguish "not loaded yet" from "loaded, zero unviewed"
    ownerUnviewedCount: ownerUnviewedCount as number | undefined,
    followingUnviewedCount: followingUnviewedCount as number | undefined,
    refetch,
  };
};

export default useUnviewedNotificationsCount;
