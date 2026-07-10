import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import NotificationsIcon from "navigation/BottomTabNavigator/NotificationsIcon";
import React, { useEffect } from "react";
import {
  useAuthenticatedQuery,
  useCurrentUser,
} from "sharedHooks";
import useStore from "stores/useStore";

interface Props {
  icon: string;
  active: boolean;
  size: number;
}

const NotificationsIconContainer = ( {
  size,
  icon,
  active,
}: Props ) => {
  const currentUser = useCurrentUser( );
  const observationMarkedAsViewedAt = useStore( state => state.observationMarkedAsViewedAt );

  // Match the same owner/following split used by the Notifications screen tabs,
  // so this badge and the in-app tab dots reflect the same "unviewed" scope.
  const { data: ownerUnviewedCount, refetch: refetchOwner } = useAuthenticatedQuery(
    ["notificationsCount", "owner"],
    optsWithAuth => fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      optsWithAuth,
    ),
    {
      enabled: !!currentUser,
      refetchInterval: 60_000,
    },
  );

  const { data: followingUnviewedCount, refetch: refetchFollowing } = useAuthenticatedQuery(
    ["notificationsCount", "following"],
    optsWithAuth => fetchUnviewedObservationUpdatesCount(
      { observations_by: "following" },
      optsWithAuth,
    ),
    {
      enabled: !!currentUser,
      refetchInterval: 60_000,
    },
  );

  useEffect( () => {
    if ( currentUser ) {
      refetchOwner();
      refetchFollowing();
    }
  }, [observationMarkedAsViewedAt, refetchOwner, refetchFollowing, currentUser] );

  const hasUnread = ( ownerUnviewedCount ?? 0 ) > 0 || ( followingUnviewedCount ?? 0 ) > 0;

  return (
    <NotificationsIcon
      icon={icon}
      unread={hasUnread}
      active={active}
      size={size}
    />
  );
};

export default NotificationsIconContainer;
