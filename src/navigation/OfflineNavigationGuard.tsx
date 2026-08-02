import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { NavigationContainer } from "@react-navigation/native";
import { useReactNavigationDevTools } from "@rozenite/react-navigation-plugin";
import type { PropsWithChildren } from "react";
import React, { useEffect, useRef } from "react";
import { logFirebaseScreenView } from "sharedHelpers/tracking";
import {
  markNavigationDispatched,
  startUiDelayMonitoring,
  trackScreenTransition,
} from "sharedHelpers/uiDelayTracker";

import { navigationRef } from "./navigationUtils";

const OfflineNavigationGuard = ( { children }: PropsWithChildren ) => {
  const routeNameRef = useRef( navigationRef.current?.getCurrentRoute()?.name );
  const { isConnected } = useNetInfo( );

  useReactNavigationDevTools( { ref: navigationRef } );

  useEffect( ( ) => {
    startUiDelayMonitoring( );
  }, [] );

  // if a user tries to navigate to the Login screen while they're
  // offline, they'll see this no internet alert and automatically land
  // back on the screen they came from
  const onStateChange = ( ) => {
    const previousRouteName = routeNameRef.current;
    const currentRouteName = navigationRef.current?.getCurrentRoute( )?.name;
    const screenChanged = previousRouteName !== currentRouteName && !!currentRouteName;
    // Basic screen tracking with Firebase Analytics. Without recording the new
    // route below, every state change (including param-only changes on the
    // screen we're already on) counted as a screen view, and returning to the
    // screen we launched on counted as none.
    if ( screenChanged ) {
      logFirebaseScreenView( currentRouteName );
    }
    routeNameRef.current = currentRouteName;
    if ( currentRouteName === "Login" && !isConnected ) {
      // return to previous screen if offline
      navigationRef.current?.goBack( );
      return;
    }
    trackScreenTransition( {
      fromScreen: previousRouteName,
      toScreen: currentRouteName,
    } );
  };

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        routeNameRef.current = navigationRef.current?.getCurrentRoute()?.name;
        // The action listener is documented as debugging-only, which is exactly
        // what this is: it's the only hook that fires when navigation is asked
        // to move, before any state change, so it's where a transition's clock
        // starts.
        navigationRef.current?.addListener( "__unsafe_action__", markNavigationDispatched );
      }}
      onStateChange={onStateChange}
    >
      {children}
    </NavigationContainer>
  );
};

export default OfflineNavigationGuard;
