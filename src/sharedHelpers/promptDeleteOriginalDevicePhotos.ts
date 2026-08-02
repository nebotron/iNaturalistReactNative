import {
  CameraRoll,
  iosRequestReadWriteGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import i18next from "i18next";
import { Alert, NativeModules, Platform } from "react-native";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

const logger = log.extend( "promptDeleteOriginalDevicePhotos" );

// As of iOS 26, a hung deletePhotos or updateAssetLocation call (see
// ImageCropper.m) can mean PHPhotoLibrary's confirmation machinery is wedged
// for the whole device — Apple Developer Forums thread 806349 — until a
// restart. Retrying on every subsequent import just repeats the same hang,
// and may be compounding whatever is stuck. Once one of these calls times
// out, skip attempting either kind for a cooldown instead of hammering it; a
// later success (e.g. after the user restarts) clears the cooldown
// immediately. Shared with applyTrackedLocationToPhotos.ts, which hits the
// same underlying confirmation machinery.
const LAST_PHOTO_LIBRARY_WRITE_FAILURE_STORAGE_KEY = "photo-library-write-last-failure-at";
const PHOTO_LIBRARY_WRITE_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

export const isInPhotoLibraryWriteCooldown = ( ): boolean => {
  const lastFailureAt = zustandStorage.getItem( LAST_PHOTO_LIBRARY_WRITE_FAILURE_STORAGE_KEY );
  return typeof lastFailureAt === "number"
    && ( Date.now() - lastFailureAt ) < PHOTO_LIBRARY_WRITE_FAILURE_COOLDOWN_MS;
};

export const recordPhotoLibraryWriteFailure = ( ) => zustandStorage.setItem(
  LAST_PHOTO_LIBRARY_WRITE_FAILURE_STORAGE_KEY,
  Date.now(),
);

export const clearPhotoLibraryWriteFailure = ( ) => zustandStorage.removeItem(
  LAST_PHOTO_LIBRARY_WRITE_FAILURE_STORAGE_KEY,
);

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

// What the OS actually did, so callers can tell the user the truth instead of
// assuming every requested URI was deleted. A hung or cooled-down delete
// resolves normally (the error is handled here), so without this a caller
// can't distinguish "deleted 1159 photos" from "deleted none of them".
export interface DeleteOriginalDevicePhotosResult {
  deleted: number;
  requested: number;
  succeeded: boolean;
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

// iOS presents a single system confirmation per Photos-library write. Firing
// a second write (delete OR location update, see applyTrackedLocationToPhotos.ts)
// while one is still in flight can make both hang (iOS won't present a second
// confirmation over the first), and a burst of concurrent writes can also
// spuriously trip each other's timeout under normal I/O load, which then
// poisons the cooldown above for every write that follows — including
// unrelated deletions. Route every native Photos-library write (not just
// deletions) through this single chain so only one is ever in flight.
let photoLibraryWriteChain: Promise<void> = Promise.resolve( );

export const enqueuePhotoLibraryWrite = <T, >( task: ( ) => Promise<T> ): Promise<T> => {
  const run = photoLibraryWriteChain.then( task );
  // Keep the chain alive even if this write rejects, so later writes still fire.
  photoLibraryWriteChain = run.then( ( ) => undefined, ( ) => undefined );
  return run;
};

// A hung deletePhotos (confirmation never presents) must not block the chain
// forever, or one bad call poisons every later deletion for the whole session.
// Long enough for a real user to respond to the confirmation, short enough to
// recover from a genuine hang.
const DELETE_TIMEOUT_MS = 120000;

const performDeleteOriginalDevicePhotos = async (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
): Promise<DeleteOriginalDevicePhotosResult> => {
  const uniqueUris = filterDeletableDevicePhotoUris( photoUris );
  if ( uniqueUris.length === 0 ) {
    if ( photoUris.filter( Boolean ).length > 0 ) {
      logger.warn(
        "Skipped deleting device photos because no deletable URIs were resolved",
        { photoUris },
      );
    }
    return { deleted: 0, requested: 0, succeeded: true };
  }

  const requested = uniqueUris.length;

  if ( Platform.OS === "ios" && isInPhotoLibraryWriteCooldown( ) ) {
    logger.warn(
      `Skipped deleting ${requested} device photo(s): `
      + "still in cooldown after a recent Photos-library write timeout (likely a "
      + "wedged PHPhotoLibrary confirmation — see promptDeleteOriginalDevicePhotos.ts)",
    );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return { deleted: 0, requested, succeeded: false };
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
    return { deleted: 0, requested, succeeded: false };
  }

  const uriList = uniqueUris.join( ", " );
  const hangTimer = setTimeout( ( ) => {
    logger.error(
      `deletePhotos still pending after 20s for ${uniqueUris.length} uri(s): ${uriList}`,
    );
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
    // Report what the OS actually deleted, not what we asked for. A call that
    // resolves with deleted:0 (e.g. fetched:0 — every URI is a ghost pointing
    // at an already-deleted asset) is a no-op, and logging it as a deletion of
    // all N made a repeating no-op look like a working cleanup.
    const deleted = ( result as { deleted?: number } | undefined )?.deleted;
    logger.info(
      `Deleted ${deleted ?? requested} of ${requested} `
      + `device photo(s); result=${JSON.stringify( result )}`,
    );
    clearPhotoLibraryWriteFailure( );
    return { deleted: deleted ?? requested, requested, succeeded: true };
  } catch ( deleteError ) {
    // As of iOS 26, PHPhotoLibrary.performChanges' completion handler for
    // deleteAssets can simply never fire — no confirmation dialog, no error,
    // no library change (confirmed via a native PHPhotoLibraryChangeObserver
    // fallback in ImageCropper.m, and matches Apple Developer Forums thread
    // 806349). There's no way to make the OS call back; the cooldown above
    // is a mitigation (stop repeating the same 120s hang on every import),
    // not a fix. Restarting the device is still the only way to clear it.
    logger.error( `Error deleting device photos (${uriList})`, deleteError );
    const timedOut = deleteError instanceof Error
      && deleteError.message.includes( "timed out" );
    if ( Platform.OS === "ios" && timedOut ) recordPhotoLibraryWriteFailure( );
    if ( options.userInitiated ) {
      Alert.alert(
        i18next.t( "Something-went-wrong" ),
        i18next.t( "Could-not-delete-original-photos" ),
      );
    }
    return { deleted: 0, requested, succeeded: false };
  } finally {
    clearTimeout( hangTimer );
    if ( timeoutTimer ) clearTimeout( timeoutTimer );
  }
};

export const deleteOriginalDevicePhotos = (
  photoUris: string[],
  options: DeleteOriginalDevicePhotosOptions = {},
): Promise<DeleteOriginalDevicePhotosResult> => enqueuePhotoLibraryWrite(
  ( ) => performDeleteOriginalDevicePhotos( photoUris, options ),
);

// Callers hold the user on the current screen until onComplete fires so the
// iOS deletion confirmation isn't asked to present mid-navigation. A deletion
// normally settles in a couple of seconds, but a wedged PHPhotoLibrary (see
// above) doesn't settle until DELETE_TIMEOUT_MS, and stranding the user for
// two minutes on a screen they asked to leave is far worse than letting the
// deletion finish unobserved in the background.
const EXIT_WAIT_TIMEOUT_MS = 20000;

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

  let completed = false;
  const completeOnce = ( ) => {
    if ( completed ) return;
    completed = true;
    onComplete( );
  };
  const waitTimer = setTimeout( ( ) => {
    logger.warn(
      `Proceeding without waiting for deletion of ${uniqueUris.length} device photo(s): `
      + `still pending after ${EXIT_WAIT_TIMEOUT_MS}ms`,
    );
    completeOnce( );
  }, EXIT_WAIT_TIMEOUT_MS );

  void deleteOriginalDevicePhotos( uniqueUris ).finally( ( ) => {
    clearTimeout( waitTimer );
    completeOnce( );
  } );
};

export default promptDeleteOriginalDevicePhotos;
