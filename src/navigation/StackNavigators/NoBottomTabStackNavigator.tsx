// eslint-disable-next-line import/no-extraneous-dependencies
import { createNativeStackNavigator } from "@react-navigation/native-stack";
// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
// eslint-disable-next-line import/no-unresolved
import CameraContainer from "components/Camera/CameraContainer";
import { Heading4 } from "components/SharedComponents";
import Mortal from "components/SharedComponents/Mortal";
import PermissionGateContainer, {
  AUDIO_PERMISSIONS,
  CAMERA_PERMISSIONS,
} from "components/SharedComponents/PermissionGateContainer";
import SoundRecorder from "components/SoundRecorder/SoundRecorder";
import { t } from "i18next";
import {
  fadeInComponent,
  hideHeader,
  hideHeaderLeft,
} from "navigation/navigationOptions";
import { StackHostProvider } from "navigation/StackHostContext";
import type { NoBottomTabStackParamList } from "navigation/types";
import React from "react";

import PhotoImporterStackScreens from "./PhotoImporterStackScreens";
import SharedStackScreens from "./SharedStackScreens";

const Stack = createNativeStackNavigator<NoBottomTabStackParamList>( );

const soundRecorderTitle = () => (
  <Heading4 className="text-white" accessibilityRole="header" numberOfLines={1}>
    {t( "RECORD-NEW-SOUND" )}
  </Heading4>
);

const CAMERA_SCREEN_OPTIONS = {
  ...hideHeader,
  contentStyle: {
    backgroundColor: "black",
  },
} as const;

const SOUND_RECORDER_OPTIONS = {
  ...hideHeaderLeft,
  headerStyle: {
    backgroundColor: "black",
  },
  headerTintColor: "white",
  headerTitle: soundRecorderTitle,
  headerTitleAlign: "center",
} as const;

const CameraContainerWithPermission = ( ) => fadeInComponent(
  <Mortal>
    <PermissionGateContainer
      permissions={CAMERA_PERMISSIONS}
      title={t( "Identify-organisms-in-real-time-with-your-camera" )}
      titleDenied={t( "Please-allow-Camera-Access" )}
      body={t( "Use-the-iNaturalist-camera-to-see-real-time-identifications-and-take-photos" )}
      blockedPrompt={t( "Youve-previously-denied-camera-permissions" )}
      buttonText={t( "OBSERVE-ORGANISMS" )}
      icon="camera"
      image={require( "images/background/viviana-rishe-j2330n6bg3I-unsplash.jpg" )}
    >
      <CameraContainer />
    </PermissionGateContainer>
  </Mortal>,
);

const SoundRecorderWithPermission = ( ) => fadeInComponent(
  <Mortal>
    <PermissionGateContainer
      permissions={AUDIO_PERMISSIONS}
      title={t( "Record-animal-sounds" )}
      titleDenied={t( "Please-allow-Microphone-Access" )}
      body={t( "Use-your-devices-microphone-to-record-animal-sounds-and-share-them" )}
      blockedPrompt={t( "Youve-previously-denied-microphone-permissions" )}
      buttonText={t( "RECORD-SOUND" )}
      icon="microphone"
      image={require( "images/background/azmaan-baluch-_ra6NcejHVs-unsplash.jpg" )}
    >
      <SoundRecorder />
    </PermissionGateContainer>
  </Mortal>,
);

const NoBottomTabStackNavigator = ( ) => (
  <StackHostProvider value={{ hasBottomTabBar: false }}>
    <Stack.Navigator
      screenOptions={{
        headerBackButtonDisplayMode: "minimal",
        contentStyle: {
          backgroundColor: "white",
        },
      }}
    >
      {/* Add Observation Stack Group */}
      <Stack.Group>
        <Stack.Screen
          name="Camera"
          component={CameraContainerWithPermission}
          options={CAMERA_SCREEN_OPTIONS}
        />
        {PhotoImporterStackScreens( )}
        <Stack.Screen
          name="SoundRecorder"
          component={SoundRecorderWithPermission}
          options={SOUND_RECORDER_OPTIONS}
        />
      </Stack.Group>
      {SharedStackScreens( )}
    </Stack.Navigator>
  </StackHostProvider>
);

export default NoBottomTabStackNavigator;
