import { Heading4 } from "components/SharedComponents";
import type { TabComponentProps } from "components/SharedComponents/Tabs/Tabs";
import { View } from "components/styledComponents";
import React, { useEffect } from "react";
import { EventRegister } from "react-native-event-listeners";
import {
  useCurrentUser,
  useUnviewedNotificationsCount,
} from "sharedHooks";

export const OWNER_TAB = "owner";
export const OTHER_TAB = "other";
export const NOTIFICATIONS_REFRESHED = "notifications-refreshed";

const NotificationsTab = ( { id, text }: TabComponentProps ) => {
  const currentUser = useCurrentUser( );

  const {
    ownerUnviewedCount, followingUnviewedCount, refetch,
  } = useUnviewedNotificationsCount( );
  const numUnviewed = id === OWNER_TAB ? ownerUnviewedCount : followingUnviewedCount;

  useEffect( ( ) => {
    const listener = EventRegister.addEventListener(
      NOTIFICATIONS_REFRESHED,
      ( tabId: string ) => {
        if ( tabId === id && !!currentUser ) {
          refetch( );
        }
      },
    );
    return ( ) => {
      EventRegister?.removeEventListener( listener as string );
    };
  }, [currentUser, id, refetch] );

  return (
    <View className="flex-row px-3 pt-4 pb-3 justify-center items-center">
      <Heading4
        maxFontSizeMultiplier={1.5}
        numberOfLines={1}
      >
        { text }
      </Heading4>
      { ( numUnviewed ?? 0 ) > 0 && (
        <View className="h-[6px] w-[6px] ml-1 rounded-full bg-inatGreen" />
      ) }
    </View>
  );
};

export default NotificationsTab;
