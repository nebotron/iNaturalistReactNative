import NotificationsIcon from "navigation/BottomTabNavigator/NotificationsIcon";
import React from "react";
import { useUnviewedNotificationsCount } from "sharedHooks";

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
  const {
    ownerUnviewedCount, followingUnviewedCount, ownerReady, followingReady,
  } = useUnviewedNotificationsCount( { preload: true } );
  // Only once the notifications behind the dot are loaded, so following it
  // never lands on a spinner
  const hasUnread = ( ownerReady && ( ownerUnviewedCount ?? 0 ) > 0 )
    || ( followingReady && ( followingUnviewedCount ?? 0 ) > 0 );

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
