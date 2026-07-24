import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import { Alert, NativeModules, Platform } from "react-native";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "promptDeleteOriginalDevicePhotos" );

// Native helpers (iOS) that (a) report the window/scene/modal state governing
// whether the iOS deletion confirmation can present, and (b) delete after
// dismissing any modal that would block that confirmation.
const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    photoDeletionContext?: ( phUris: string[] ) => Promise<string>;
    deletePhotoAssets?: (
      phUris: string[]
    ) => Promise<{ deleted: number; requested: number; fetched?: number }>;
  };
};

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

// iOS presents a single system confirmation per deletePhotos call. Firing a
// second call while one is still awaiting that confirmation makes both hang
// (iOS won't present a second deletion alert over the first). Serialize every
// call through this chain so only one confirmation is ever in flight.
let deletionChain: Promise<void> = Promise.resolve( );

// A hung deletePhotos (confirmation never presents) must not block the chain
// forever, or one bad call poisons every later deletion for the whole session.
// Long enough for a real user to respond to the confirmation, short enough to
// recover from a genuine hang.
const DELETE_TIMEOUT_MS = 120000;

const performDeleteOriginalDevicePhotos = async (
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
  const hangTimer = setTimeout( ( ) => {
    logger.error( `deletePhotos still pending after 20s for ${uniqueUris.length} uri(s): ${uriList}` );
  }, 20000 );
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Capture the native presentation state first so a hung delete still leaves
    // behind why the confirmation couldn't present (modal in vcChain, no scene…).
    if ( Platform.OS === "ios" && ImageCropper?.photoDeletionContext ) {
      try {
        logger.info( `deletion context: ${await ImageCropper.photoDeletionContext( uniqueUris )}` );
      } catch ( ctxError ) {
        logger.warn( "Failed to read photo deletion context", ctxError );
      }
    }

    logger.info( `Deleting ${uniqueUris.length} device photo(s): ${uriList}` );
    // Prefer the native path that dismisses a blocking modal before deleting;
    // fall back to CameraRoll on platforms/builds without it.
    const deletion = ( Platform.OS === "ios" && ImageCropper?.deletePhotoAssets )
      ? ImageCropper.deletePhotoAssets( uniqueUris )
      : CameraRoll.deletePhotos( uniqueUris );
    const result = await Promise.race( [
      deletion,
      new Promise( ( _resolve, reject ) => {
        timeoutTimer = setTimeout(
          ( ) => reject( new Error( `deletePhotos timed out after ${DELETE_TIMEOUT_MS}ms` ) ),
          DELETE_TIMEOUT_MS,
        );
      } ),
    ] );
    logger.info( `Deleted ${uniqueUris.length} device photo(s); result=${JSON.stringify( result )}` );
  } catch ( deleteError ) {
    logger.error( `Error deleting device photos (${uriList})`, deleteError );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
  } finally {
    clearTimeout( hangTimer );
    if ( timeoutTimer ) clearTimeout( timeoutTimer );
  }
};

export const deleteOriginalDevicePhotos = (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
): Promise<void> => {
  const run = deletionChain.then(
    ( ) => performDeleteOriginalDevicePhotos( photoUris, options ),
  );
  // Keep the chain alive even if this run rejects, so later deletions still fire.
  deletionChain = run.catch( ( ) => undefined );
  return run;
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
