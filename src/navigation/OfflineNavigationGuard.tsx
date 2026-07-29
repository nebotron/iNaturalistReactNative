import {
  useNetInfo,
} from "@react-native-community/netinfo";
import type { NavigationState } from "@react-navigation/native";
import { NavigationContainer } from "@react-navigation/native";
import { useReactNavigationDevTools } from "@rozenite/react-navigation-plugin";
import type { PropsWithChildren } from "react";
import React, { useEffect, useRef, useState } from "react";
import { logFirebaseScreenView } from "sharedHelpers/tracking";
import {
  markNavigationDispatched,
  startUiDelayMonitoring,
  trackNavStatePersist,
  trackScreenTransition,
} from "sharedHelpers/uiDelayTracker";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

import { navigationRef } from "./navigationUtils";

const PERSISTED_NAVIGATION_STATE_KEY = "persisted-navigation-state";

const OfflineNavigationGuard = ( { children }: PropsWithChildren ) => {
  const routeNameRef = useRef( navigationRef.current?.getCurrentRoute()?.name );
  const { isConnected } = useNetInfo( );
  const [isReady, setIsReady] = useState( false );
  const [initialState, setInitialState] = useState<NavigationState | undefined>( undefined );

  useReactNavigationDevTools( { ref: navigationRef } );

  useEffect( ( ) => {
    startUiDelayMonitoring( );
  }, [] );

  useEffect( ( ) => {
    try {
      const savedStateString = zustandMMKVBackingStorage.getString(
        PERSISTED_NAVIGATION_STATE_KEY,
      );
      if ( savedStateString ) {
        setInitialState( JSON.parse( savedStateString ) );
      }
    } catch {
      // If the persisted state can't be restored (e.g. corrupted or from an
      // older app version), just fall back to the default initial route
    } finally {
      setIsReady( true );
    }
  }, [] );

  // if a user tries to navigate to the Login screen while they're
  // offline, they'll see this no internet alert and automatically land
  // back on the screen they came from
  const onStateChange = ( state?: NavigationState ) => {
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
    let persistMs = 0;
    try {
      const persistStartedAt = Date.now( );
      const serializedState = JSON.stringify( state );
      zustandMMKVBackingStorage.set( PERSISTED_NAVIGATION_STATE_KEY, serializedState );
      persistMs = Date.now( ) - persistStartedAt;
      trackNavStatePersist( persistMs, serializedState.length );
    } catch {
      // Some routes carry non-serializable params (e.g. Realm objects); if
      // the current state can't be saved, just skip persisting this change
    }
    trackScreenTransition( {
      fromScreen: previousRouteName,
      toScreen: currentRouteName,
      persistMs,
    } );
  };

  if ( !isReady ) {
    return null;
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      initialState={initialState}
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
