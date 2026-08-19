import { useNavigation } from "@react-navigation/native";
import RootStackNavigator from "navigation/RootStackNavigator";
import type { PropsWithChildren } from "react";
import React, { useCallback } from "react";
import { installNetworkInterceptor } from "sharedHelpers/networkLogger";
import useCurrentUser from "sharedHooks/useCurrentUser";
import type { SharedData } from "sharedHooks/useShare";
import useShare from "sharedHooks/useShare";

import AppStateListener from "./AppStateListener";
import useDeferredStartup from "./hooks/useDeferredStartup";
import useLinking from "./hooks/useLinking";
import useResumeGroupPhotos from "./hooks/useResumeGroupPhotos";
import useUsbAutoImport from "./hooks/useUsbAutoImport";
import NetworkService from "./NetworkService";
import StartupService from "./StartupService";
import UploadService from "./UploadService";

installNetworkInterceptor( );

const handleShare = ( navigation, item?: SharedData | null ) => {
  if ( !item ) {
    // user hasn't shared any items
    return;
  }

  const { data } = item;

  if ( !data ) {
    // user hasn't shared any images
    return;
  }

  // show user a loading animation screen (like PhotoLibrary)
  // while observations are created
  navigation?.navigate( "NoBottomTabStackNavigator", {
    screen: "PhotoSharing",
    params: { item },
  } );
};

// this children prop is here for the sake of testing with jest
// normally we would never do this in code
const App = ( { children }: PropsWithChildren ) => {
  const navigation = useNavigation( );

  // attempting to make sure that navigation is only called once
  // for performance reasons
  const onShare = useCallback(
    ( item?: SharedData | null ) => handleShare( navigation, item ),
    [navigation],
  );

  const currentUser = useCurrentUser( );

  useLinking( currentUser );
  useShare( onShare );
  useDeferredStartup( );
  useResumeGroupPhotos( );
  useUsbAutoImport( );

  // this children prop is here for the sake of testing with jest
  // normally we would never do this in code
  return (
    <>
      <StartupService />
      <NetworkService />
      <UploadService />
      <AppStateListener />
      {children || <RootStackNavigator />}
    </>
  );
};

export default App;
