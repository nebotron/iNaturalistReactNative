import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import {
  deleteUsbSourceImages,
  getUsbFolderDiagnostics,
  getUsbFolderName,
  isUsbImportSupported,
  listNewUsbImages,
  markUsbImagesImported,
  requestUsbPhotosPermission,
  saveUsbImageToPhotos,
} from "sharedHelpers/usbStorage";
import useUsbImportProgress from "stores/usbImportProgress";

const logger = log.extend( "useUsbAutoImport" );

// How often to re-check the watched folder while the app is foregrounded.
const SCAN_INTERVAL_MS = 10_000;

// Safety net so a single native call that never resolves (a stuck copy or
// Photos import) can't freeze the whole run — that file is counted as failed
// and the loop moves on.
const SAVE_TIMEOUT_MS = 30_000;

const withTimeout = <T, >( promise: Promise<T>, ms: number ): Promise<T> => (
  Promise.race( [
    promise,
    new Promise<T>( ( _resolve, reject ) => {
      setTimeout( ( ) => reject( new Error( `timed out after ${ms}ms` ) ), ms );
    } ),
  ] )
);

// Watches the user's chosen USB folder (see UsbImportSetting) on launch and,
// while the app is foregrounded, on a short interval. iOS offers no attach
// notification, and a drive is commonly plugged in *after* the app is already
// open — a moment that fires neither a launch nor a foreground event — so
// polling is the only way to notice it. When new images are found they are
// offloaded: each is saved into the Photos library, then — once the whole
// batch is safely saved — deleted from the source device. A progress overlay
// (UsbImportProgress) reflects the run.
const useUsbAutoImport = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const offloading = useRef( false );
  // The scan runs every SCAN_INTERVAL_MS while foregrounded, and each remote
  // log line is a network POST, so logging every tick would flood the log.
  // Only emit a diagnostic when its text changes from the last one.
  const lastDiag = useRef<string>( "" );
  const logDiag = useCallback( ( msg: string ) => {
    if ( msg === lastDiag.current ) return;
    lastDiag.current = msg;
    logger.info( `[diag] ${msg}` );
  }, [] );

  const offload = useCallback( async ( ) => {
    if ( !isUsbImportSupported( ) ) { logDiag( "skip: not supported on this platform" ); return; }
    // An offload already in flight is normal overlap on the poll, not an error.
    if ( offloading.current ) return;
    if ( !onboardingShown ) { logDiag( "skip: onboarding not shown yet" ); return; }
    offloading.current = true;
    const progress = useUsbImportProgress.getState( );
    try {
      const result = await listNewUsbImages( );
      logDiag( result.available
        ? `list ok: ${result.images.length} new; imageFiles=${result.imageFileCount}, `
          + `alreadyImported=${result.alreadyImportedCount}, known=${result.knownCount}, `
          + `regularFiles=${result.regularFileCount}, `
          + `extensions=${JSON.stringify( result.extensions ?? {} )}`
        : `list produced nothing: ${result.reason}` );
      const { images } = result;
      if ( images.length === 0 ) return;

      // Get Photos permission before showing progress or touching any file, so
      // the system prompt appears up front rather than mid-loop (where it was
      // hiding behind the overlay and stalling the run at 0/N).
      const permission = await requestUsbPhotosPermission( );
      logDiag( `photos permission: ${permission}` );
      if ( permission !== "authorized" && permission !== "limited" ) {
        logger.error( `USB offload: Photos permission ${permission}; not importing` );
        return;
      }

      logger.info( `USB offload: saving ${images.length} photos to Photos library` );
      progress.start( images.length );

      // Save each image to Photos, one at a time so memory stays flat and the
      // progress count is accurate. Track successes for the batch delete.
      const savedPaths: string[] = [];
      let failed = 0;
      for ( let i = 0; i < images.length; i += 1 ) {
        const { relativePath } = images[i];
        try {
          // eslint-disable-next-line no-await-in-loop
          await withTimeout( saveUsbImageToPhotos( relativePath ), SAVE_TIMEOUT_MS );
          savedPaths.push( relativePath );
        } catch ( err ) {
          failed += 1;
          logger.error( `USB offload: failed to save ${relativePath}`, err );
        }
        progress.setCounts( savedPaths.length, failed );
      }

      // Remember what we saved before touching the card, so an interrupted or
      // failed delete never causes the same photo to be saved twice.
      markUsbImagesImported( savedPaths );

      // Delete from the source device only after the whole batch is safely in
      // Photos (per the user's choice), and only the files that actually saved.
      if ( savedPaths.length > 0 ) {
        progress.setPhase( "deleting" );
        const del = await deleteUsbSourceImages( savedPaths );
        progress.setDeleted( del.deleted );
        logger.info(
          `USB offload: saved ${savedPaths.length}, failed ${failed}; `
          + `deleted ${del.deleted} from device (${del.failed} delete failures)`,
        );
      }
      progress.setPhase( failed > 0 ? "error" : "done" );
    } catch ( error ) {
      logger.error( "USB offload failed", error );
      progress.setPhase( "error" );
    } finally {
      offloading.current = false;
      // Leave the final state on screen briefly, then dismiss the overlay.
      setTimeout( ( ) => useUsbImportProgress.getState( ).finish( ), 4000 );
    }
  }, [onboardingShown, logDiag] );

  useEffect( ( ) => {
    // Report why the hook does or doesn't engage. This runs before the guard
    // below, so it fires even in the cases (native module missing, onboarding
    // not finished) that otherwise leave the feature completely silent.
    const supported = isUsbImportSupported( );
    logDiag( `hook mounted: supported=${supported}, onboardingShown=${onboardingShown}` );
    if ( !supported || !onboardingShown ) return undefined;

    let interval: ReturnType<typeof setInterval> | undefined;
    const stopPolling = ( ) => {
      if ( interval ) clearInterval( interval );
      interval = undefined;
    };
    const startPolling = async ( ) => {
      stopPolling( );
      try {
        // Nothing to watch until the user has chosen a folder; don't wake the JS
        // thread on an interval for the many users who never set one up.
        const folder = await getUsbFolderName( );
        if ( !folder ) {
          // A null name has two very different causes; report which one so we
          // don't conflate "never set up" with "drive not mounted right now".
          const d = await getUsbFolderDiagnostics( );
          logDiag( d.bookmarkPresent
            ? "not polling: folder bookmark saved but did not resolve "
              + `(resolved=${d.resolved}, reachable=${d.reachable}, stale=${d.stale})`
            : "not polling: no folder bookmark saved (folder never picked in Settings)" );
          return;
        }
        logDiag( `polling USB folder "${folder}" every ${SCAN_INTERVAL_MS}ms` );
        offload( );
        interval = setInterval( offload, SCAN_INTERVAL_MS );
      } catch ( error ) {
        // A rejected native call would otherwise be an unhandled promise
        // rejection with no trace of why polling never started.
        logger.error( "USB polling failed to start", error );
      }
    };

    startPolling( );
    const subscription = AppState.addEventListener( "change", nextAppState => {
      if ( nextAppState === "active" ) startPolling( );
      else stopPolling( );
    } );
    return ( ) => {
      stopPolling( );
      subscription.remove( );
    };
  }, [offload, onboardingShown, logDiag] );
};

export default useUsbAutoImport;
