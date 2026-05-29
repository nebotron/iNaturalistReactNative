import {
  CameraRoll,
  iosReadGalleryPermission,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import { Alert, Linking, Platform } from "react-native";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

const logger = log.extend( "promptDeleteOriginalDevicePhotos" );

const DELETE_ORIGINAL_PHOTOS_PREFERENCE_KEY = "deleteOriginalPhotosAfterImport";
const DELETE_ORIGINAL_PHOTOS_PERMISSION_REQUESTED_KEY = "deleteOriginalPhotosPermissionRequested";
const DELETE_ORIGINAL_PHOTOS_SETTINGS_PROMPTED_KEY = "deleteOriginalPhotosSettingsPrompted";

type DeleteOriginalPhotosPreference = "delete" | "keep";

interface DeleteOriginalDevicePhotosOptions {
  userInitiated?: boolean;
}

const getDeleteOriginalPhotosPreference = ( ):
DeleteOriginalPhotosPreference | null => {
  const value = zustandStorage.getItem( DELETE_ORIGINAL_PHOTOS_PREFERENCE_KEY );
  if ( value === "delete" || value === "keep" ) {
    return value;
  }
  return null;
};

const setDeleteOriginalPhotosPreference = (
  preference: DeleteOriginalPhotosPreference,
) => {
  zustandStorage.setItem( DELETE_ORIGINAL_PHOTOS_PREFERENCE_KEY, preference );
};

const canDeleteFromPhotoLibrary = ( status: string ) => (
  status === "granted" || status === "limited"
);

const filterDeletableDevicePhotoUris = ( photoUris: string[] ): string[] => (
  [...new Set(
    photoUris
      .map( uri => normalizeDevicePhotoUri( uri ) )
      .filter( ( uri ): uri is string => !!uri ),
  )].filter( uri => {
    if ( Platform.OS === "ios" ) {
      return uri.startsWith( "ph://" );
    }
    return uri.startsWith( "content://" ) || uri.startsWith( "file://" );
  } )
);

const promptToOpenPhotoLibrarySettings = ( status: string ) => {
  if ( status !== "denied" && status !== "blocked" ) {
    return;
  }
  if ( zustandStorage.getItem( DELETE_ORIGINAL_PHOTOS_SETTINGS_PROMPTED_KEY ) === "true" ) {
    return;
  }
  zustandStorage.setItem( DELETE_ORIGINAL_PHOTOS_SETTINGS_PROMPTED_KEY, "true" );

  Alert.alert(
    i18next.t( "Something-went-wrong" ),
    i18next.t( "Youve-denied-permission-prompt" ),
    [
      {
        text: i18next.t( "Cancel" ),
        style: "cancel",
      },
      {
        text: i18next.t( "OPEN-SETTINGS" ),
        onPress: () => {
          void Linking.openSettings( );
        },
      },
    ],
  );
};

const ensureDeletePhotosPermission = async (
  userInitiated = false,
): Promise<boolean> => {
  if ( Platform.OS !== "ios" ) {
    return true;
  }

  const currentStatus = await iosReadGalleryPermission( "readWrite" );
  if ( canDeleteFromPhotoLibrary( currentStatus ) ) {
    return true;
  }

  const permissionRequested = zustandStorage.getItem(
    DELETE_ORIGINAL_PHOTOS_PERMISSION_REQUESTED_KEY,
  ) === "true";

  if ( !permissionRequested ) {
    zustandStorage.setItem( DELETE_ORIGINAL_PHOTOS_PERMISSION_REQUESTED_KEY, "true" );
    const requestedStatus = await iosRequestReadWriteGalleryPermission( );
    if ( canDeleteFromPhotoLibrary( requestedStatus ) ) {
      return true;
    }
    if ( userInitiated ) {
      promptToOpenPhotoLibrarySettings( requestedStatus );
    }
    return false;
  }

  if ( userInitiated ) {
    promptToOpenPhotoLibrarySettings( currentStatus );
  }
  return false;
};

export const deleteOriginalDevicePhotos = async (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
) => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    if ( photoUris.filter( Boolean ).length > 0 ) {
      logger.warn(
        "Skipped deleting device photos because no deletable URIs were resolved",
        { photoUris },
      );
    }
    return;
  }

  const hasPermission = await ensureDeletePhotosPermission( options.userInitiated );
  if ( !hasPermission ) {
    if ( !options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return;
  }

  try {
    await CameraRoll.deletePhotos( uniqueUris );
  } catch ( deleteError ) {
    logger.error( "Error deleting original device photos", deleteError, { uniqueUris } );
    Alert.alert(
      i18next.t( "Something-went-wrong" ),
      i18next.t( "Could-not-delete-original-photos" ),
    );
  }
};

const promptDeleteOriginalDevicePhotos = (
  photoUris: string[],
  onComplete: () => void,
) => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    onComplete( );
    return;
  }

  const preference = getDeleteOriginalPhotosPreference( );
  if ( preference === "delete" ) {
    void deleteOriginalDevicePhotos( uniqueUris ).finally( onComplete );
    return;
  }
  if ( preference === "keep" ) {
    onComplete( );
    return;
  }

  Alert.alert(
    i18next.t( "Delete-original-photos--question" ),
    i18next.t( "Delete-original-photos-description" ),
    [
      {
        text: i18next.t( "Keep-photos" ),
        style: "cancel",
        onPress: () => {
          setDeleteOriginalPhotosPreference( "keep" );
          onComplete( );
        },
      },
      {
        text: i18next.t( "Delete-photos" ),
        style: "destructive",
        onPress: () => {
          setDeleteOriginalPhotosPreference( "delete" );
          void deleteOriginalDevicePhotos( uniqueUris ).finally( onComplete );
        },
      },
    ],
  );
};

export default promptDeleteOriginalDevicePhotos;
