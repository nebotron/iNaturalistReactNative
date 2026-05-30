import { fetchUnviewedObservationUpdatesCount } from "api/observations";
import type { ApiOpts } from "api/types";
import { NotificationOnboarding } from "components/OnboardingModal/PivotCards";
import { Tabs } from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, { useEffect, useRef, useState } from "react";
import { EventRegister } from "react-native-event-listeners";
import {
  useAuthenticatedQuery, useCurrentUser, useLayoutPrefs, useTranslation,
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

  const { data: ownerUnviewed } = useAuthenticatedQuery(
    ["NotificationsTab", "notificationsCount", OWNER_TAB],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "owner" },
      optsWithAuth,
    ),
    { enabled: !!currentUser },
  );

  const { data: otherUnviewed } = useAuthenticatedQuery(
    ["NotificationsTab", "notificationsCount", OTHER_TAB],
    ( optsWithAuth: ApiOpts ) => fetchUnviewedObservationUpdatesCount(
      { observations_by: "following" },
      optsWithAuth,
    ),
    { enabled: !!currentUser },
  );

  useEffect( ( ) => {
    if (
      !hasAutoSelectedTab.current
      && ownerUnviewed !== undefined
      && otherUnviewed !== undefined
    ) {
      hasAutoSelectedTab.current = true;
      setActiveTab(
        Number( ownerUnviewed ) === 0 && Number( otherUnviewed ) > 0
          ? OTHER_TAB
          : OWNER_TAB,
      );
    }
  }, [ownerUnviewed, otherUnviewed] );

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
