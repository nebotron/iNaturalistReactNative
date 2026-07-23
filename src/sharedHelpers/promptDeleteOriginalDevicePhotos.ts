import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import { Alert, Platform } from "react-native";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "promptDeleteOriginalDevicePhotos" );

interface DeleteOriginalDevicePhotosOptions {
  userInitiated?: boolean;
}

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

// Requests readWrite photo library permission. iOS shows the system dialog
// exactly once (when status is notDetermined); subsequent calls return the
// cached status silently, so this acts as a global one-time grant.
const ensureDeletePhotosPermission = async ( ): Promise<boolean> => {
  if ( Platform.OS !== "ios" ) {
    return true;
  }
  const status = await iosRequestReadWriteGalleryPermission( );
  logger.info( `photo library readWrite permission status: ${status}` );
  // "limited" access (the user picked specific photos) still lets us delete
  // those photos — iOS shows its own deletion confirmation — so treat it the
  // same as full access. Rejecting it here silently skipped deletion for the
  // many users who grant limited access.
  return status === "granted" || status === "limited";
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

  const hasPermission = await ensureDeletePhotosPermission( );
  if ( !hasPermission ) {
    logger.warn( "Skipped deleting device photos: photo library permission not granted" );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return;
  }

  const uriList = uniqueUris.join( ", " );
  // Detect the case where CameraRoll.deletePhotos never settles (the native
  // performChanges completion handler never fires — e.g. the deletion
  // confirmation never presented). An error-level log reliably syncs.
  const hangTimer = setTimeout( ( ) => {
    logger.error( `deletePhotos still pending after 20s for ${uniqueUris.length} uri(s): ${uriList}` );
  }, 20000 );
  try {
    logger.info( `Deleting ${uniqueUris.length} device photo(s): ${uriList}` );
    const result = await CameraRoll.deletePhotos( uniqueUris );
    logger.info( `Deleted ${uniqueUris.length} device photo(s); result=${JSON.stringify( result )}` );
  } catch ( deleteError ) {
    logger.error( `Error deleting device photos (${uriList})`, deleteError );
    Alert.alert(
      i18next.t( "Something-went-wrong" ),
      i18next.t( "Could-not-delete-original-photos" ),
    );
  } finally {
    clearTimeout( hangTimer );
  }
};

// Deletes the original device photos that were imported, without prompting.
const promptDeleteOriginalDevicePhotos = (
  photoUris: string[],
  onComplete: () => void,
) => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    onComplete( );
    return;
  }

  void deleteOriginalDevicePhotos( uniqueUris ).finally( onComplete );
};

export default promptDeleteOriginalDevicePhotos;
