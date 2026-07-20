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
  const { ownerUnviewedCount, followingUnviewedCount } = useUnviewedNotificationsCount( );
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
