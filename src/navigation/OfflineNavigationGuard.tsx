import {
  useNetInfo,
} from "@react-native-community/netinfo";
import type { NavigationState } from "@react-navigation/native";
import { NavigationContainer } from "@react-navigation/native";
import { useReactNavigationDevTools } from "@rozenite/react-navigation-plugin";
import type { PropsWithChildren } from "react";
import React, { useEffect, useRef, useState } from "react";
import { logFirebaseScreenView } from "sharedHelpers/tracking";
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
    try {
      const savedStateString = zustandMMKVBackingStorage.getString( PERSISTED_NAVIGATION_STATE_KEY );
      if ( savedStateString ) {
        setInitialState( JSON.parse( savedStateString ) );
      }
    } catch ( e ) {
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
    // Basic screen tracking with Firebase Analytics
    if ( previousRouteName !== currentRouteName && currentRouteName ) {
      logFirebaseScreenView( currentRouteName );
    }
    if ( currentRouteName === "Login" && !isConnected ) {
      // return to previous screen if offline
      navigationRef.current?.goBack( );
      return;
    }
    try {
      zustandMMKVBackingStorage.set( PERSISTED_NAVIGATION_STATE_KEY, JSON.stringify( state ) );
    } catch ( e ) {
      // Some routes carry non-serializable params (e.g. Realm objects); if
      // the current state can't be saved, just skip persisting this change
    }
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
      }}
      onStateChange={onStateChange}
    >
      {children}
    </NavigationContainer>
  );
};

export default OfflineNavigationGuard;
