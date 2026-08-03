// eslint-disable-next-line import/no-extraneous-dependencies
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import GroupPhotosContainer from "components/PhotoImporter/GroupPhotosContainer";
import PhotoLibrary from "components/PhotoImporter/PhotoLibrary";
import PermissionGateContainer, {
  READ_WRITE_MEDIA_PERMISSIONS,
} from "components/SharedComponents/PermissionGateContainer";
import { t } from "i18next";
import ContextHeader from "navigation/ContextHeader";
import { hideHeader } from "navigation/navigationOptions";
import type { PhotoImporterStackParamList } from "navigation/types";
import React from "react";
import { Platform } from "react-native";

const Stack = createNativeStackNavigator<PhotoImporterStackParamList>( );

const GROUP_PHOTOS_OPTIONS = {
  header: ContextHeader,
  alignStart: true,
  lazy: true,
} as const;

// On iOS we don't actually need PHOTO LIBRARY permission to import photos,
// and in fact, if we ask for it and the user denies it after already
// granting add-only permission, the user can never grant it again until they
// uninstall the app. We *may* want to bring this back to handle writing to
// albums, but for now this works. ~~~~kueda20240829

// TODO verify this is true for Android
const PhotoLibraryContainerWithPermission = ( ) => (
  Platform.OS === "android"
    ? (
      <PermissionGateContainer
        permissions={READ_WRITE_MEDIA_PERMISSIONS}
        title={t( "Choose-photos" )}
        titleDenied={t( "Please-allow-Photo-Library-Access" )}
        body={t( "Select-photos-from-your-device-to-create-observations" )}
        blockedPrompt={t( "Youve-previously-denied-photo-library-permissions" )}
        buttonText={t( "Choose-photos" )}
        icon="photo-library"
      >
        <PhotoLibrary />
      </PermissionGateContainer>
    )
    : <PhotoLibrary />
);

// These screens are registered in the TabStackNavigator so an import keeps the
// bottom tab bar and the user can wander off to another tab and come back to
// it, and in the NoBottomTabStackNavigator so an import started from a
// full-screen context (the camera, or ObsEdit's add evidence sheet) still
// resolves within the stack it was started from.

const PhotoImporterStackScreens = ( ) => (
  <Stack.Group>
    <Stack.Screen
      name="PhotoLibrary"
      component={PhotoLibraryContainerWithPermission}
      options={hideHeader}
    />
    <Stack.Screen
      name="GroupPhotos"
      component={GroupPhotosContainer}
      options={GROUP_PHOTOS_OPTIONS}
    />
  </Stack.Group>
);

export default PhotoImporterStackScreens;
