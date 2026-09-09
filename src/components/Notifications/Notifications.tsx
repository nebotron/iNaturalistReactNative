import { useNetInfo } from "@react-native-community/netinfo";
import { useFocusEffect } from "@react-navigation/native";
import { NotificationOnboarding } from "components/OnboardingModal/PivotCards";
import { Tabs } from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback, useEffect, useRef, useState,
} from "react";
import { EventRegister } from "react-native-event-listeners";
import {
  useCurrentUser, useLayoutPrefs, useTranslation, useUnviewedNotificationsCount,
} from "sharedHooks";

import NotificationsContainer from "./NotificationsContainer";
import NotificationsTab, {
  NOTIFICATIONS_REFRESHED,
  OTHER_TAB,
  OWNER_TAB,
} from "./NotificationsTab";

const { useRealm } = RealmContext;

const OWNER_TAB_PARAMS = { observations_by: "owner" } as const;
const FOLLOWING_TAB_PARAMS = { observations_by: "following" } as const;

const Notifications = ( ) => {
  const [activeTab, setActiveTab] = useState<typeof OWNER_TAB | typeof OTHER_TAB | null>( null );
  const hasAutoSelectedTab = useRef( false );
  const { t } = useTranslation();
  const { isDefaultMode } = useLayoutPrefs( );
  const currentUser = useCurrentUser( );
  const { isConnected } = useNetInfo( );

  const {
    ownerUnviewedCount: ownerUnviewed,
    followingUnviewedCount: otherUnviewed,
    countsResolved,
    refetch: refetchUnviewedCounts,
  } = useUnviewedNotificationsCount( );

  useFocusEffect(
    useCallback( ( ) => {
      refetchUnviewedCounts( );
    }, [refetchUnviewedCounts] ),
  );

  useEffect( ( ) => {
    if ( hasAutoSelectedTab.current ) return;
    // Offline the counts never arrive, but the tabs still have cached
    // notifications to show, so pick one rather than leaving the screen
    // blank waiting on a number that isn't coming.
    if ( !countsResolved && isConnected !== false ) return;
    hasAutoSelectedTab.current = true;
    // Unknown counts are NaN here, which lands on the user's own
    // notifications — the same tab they'd get with nothing unviewed.
    setActiveTab(
      Number( ownerUnviewed ) === 0 && Number( otherUnviewed ) > 0
        ? OTHER_TAB
        : OWNER_TAB,
    );
  }, [countsResolved, isConnected, ownerUnviewed, otherUnviewed] );

  const realm = useRealm();
  const localObservationCount = realm.objects( "Observation" ).length;

  return (
    <View className="flex-1 bg-white">
      {activeTab !== null && (
        <Tabs
          tabs={[
            {
              id: OWNER_TAB,
              text: t( "MY-CONTENT--notifications" ),
              onPress: () => setActiveTab( OWNER_TAB ),
            },
            {
              id: OTHER_TAB,
              text: t( "OTHERS--notifications" ),
              onPress: () => setActiveTab( OTHER_TAB ),
            },
          ]}
          activeId={activeTab}
          TabComponent={NotificationsTab}
        />
      )}
      {activeTab === OWNER_TAB && (
        <NotificationsContainer
          currentUser={currentUser}
          notificationParams={OWNER_TAB_PARAMS}
          onRefresh={( ) => EventRegister.emit( NOTIFICATIONS_REFRESHED, OWNER_TAB )}
        />
      )}
      {activeTab === OTHER_TAB && (
        <NotificationsContainer
          currentUser={currentUser}
          notificationParams={FOLLOWING_TAB_PARAMS}
          onRefresh={( ) => EventRegister.emit( NOTIFICATIONS_REFRESHED, OTHER_TAB )}
        />
      )}
      <NotificationOnboarding
        triggerCondition={
          isDefaultMode && !!currentUser && localObservationCount < 10
        }
      />
    </View>
  );
};

export default Notifications;
