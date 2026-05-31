import { useNavigation } from "@react-navigation/native";
import { markObservationUpdatesViewed } from "api/observations";
import classnames from "classnames";
import ObsNotification from "components/Notifications/ObsNotification";
import { Pressable, View } from "components/styledComponents";
import React, { useState } from "react";
import { useAuthenticatedMutation, useLayoutPrefs } from "sharedHooks";
import type { Notification } from "sharedHooks/useInfiniteNotificationsScroll";
import { OBS_DETAILS_TAB } from "stores/createLayoutSlice";
import useStore from "stores/useStore";

interface Props {
  notification: Notification;
}

const NotificationsListItem = ( { notification }: Props ) => {
  const { setObsDetailsTab } = useLayoutPrefs( );
  const navigation = useNavigation( );
  const [localViewed, setLocalViewed] = useState( notification.viewed );
  const viewedStatus = localViewed;
  const setObservationMarkedAsViewedAt = useStore(
    state => state.setObservationMarkedAsViewedAt,
  );

  const { mutate: markViewed } = useAuthenticatedMutation(
    ( params, optsWithAuth ) => markObservationUpdatesViewed( params, optsWithAuth ),
    {
      onSuccess: ( ) => {
        setObservationMarkedAsViewedAt( new Date( ) );
      },
    },
  );

  return (
    <Pressable
      accessibilityRole="button"
      className={classnames(
        "flex-row items-center justify-between pl-[15px] py-[11px]",
        {
          "bg-inatGreen/10": !viewedStatus,
          "bg-white": viewedStatus,

        },
      )}
      onPress={( ) => {
        setLocalViewed( true );
        if ( !notification.viewed ) {
          markViewed( { id: notification.resource_uuid } );
        }
        setObsDetailsTab( OBS_DETAILS_TAB.ACTIVITY );
        navigation.push( "ObsDetails", {
          uuid: notification.resource_uuid,
          targetActivityItemID: notification.identification_id || notification.comment_id,
        } );
      }}
    >
      <ObsNotification notification={notification} />
      <View className="pr-[20px] pl-2">
        <View
          className={classnames(
            "h-[10px] w-[10px] rounded-full",
            viewedStatus
              ? "border border-lightGray"
              : "bg-inatGreen",
          )}
        />
      </View>
    </Pressable>
  );
};

export default NotificationsListItem;
