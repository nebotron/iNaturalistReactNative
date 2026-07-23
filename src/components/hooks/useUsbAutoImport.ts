import { navigationRef } from "navigation/navigationUtils";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import {
  getUsbFolderDiagnostics,
  getUsbFolderName,
  importNewUsbImages,
  isUsbImportSupported,
} from "sharedHelpers/usbStorage";
import useStore from "stores/useStore";

const logger = log.extend( "useUsbAutoImport" );

// How often to re-check the watched folder while the app is foregrounded.
const SCAN_INTERVAL_MS = 10_000;

// Checks the user's chosen USB folder (see UsbImportSetting) on launch and,
// while the app is foregrounded, on a short interval. iOS offers no attach
// notification, and a drive is commonly plugged in *after* the app is already
// open — a moment that fires neither a launch nor a foreground event — so
// polling is the only way to notice it. New images are copied into app storage
// and dropped into the GroupPhotos flow, same as photos shared into the app
// (see PhotoSharing).
const useUsbAutoImport = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const scanning = useRef( false );
  // The scan runs every SCAN_INTERVAL_MS while foregrounded, and each remote
  // log line is a network POST, so logging every tick would flood the log.
  // Only emit a diagnostic when its text changes from the last one.
  const lastDiag = useRef<string>( "" );
  const logDiag = useCallback( ( msg: string ) => {
    if ( msg === lastDiag.current ) return;
    lastDiag.current = msg;
    logger.info( `[diag] ${msg}` );
  }, [] );

  const scan = useCallback( async ( ) => {
    if ( !isUsbImportSupported( ) ) { logDiag( "skip: not supported on this platform" ); return; }
    // A scan already in flight is normal overlap, not a diagnostic-worthy state.
    if ( scanning.current ) return;
    if ( !onboardingShown ) { logDiag( "skip: onboarding not shown yet" ); return; }
    if ( !navigationRef.isReady( ) ) { logDiag( "skip: navigation not ready" ); return; }
    // Don't clobber an import/grouping session that's already underway: if the
    // user is still working through a previous batch (groupedPhotos non-empty,
    // cleared once observations are created), leave it be until they finish.
    if ( useStore.getState( ).groupedPhotos.length > 0 ) {
      logDiag( "skip: grouping session already in progress" );
      return;
    }
    scanning.current = true;
    try {
      const result = await importNewUsbImages( );
      const { photos } = result;
      // Summarize every scan outcome so a silent no-op is explainable: an
      // unavailable drive names its reason; an available one reports the file
      // counts that show whether nothing was found vs. all already imported.
      logDiag( result.available
        ? `scan ok: ${photos.length} new photos; imageFiles=${result.imageFileCount}, `
          + `alreadyImported=${result.alreadyImportedCount}, known=${result.knownCount}, `
          + `regularFiles=${result.regularFileCount}, copyFailures=${result.copyFailureCount}`
        : `scan produced no photos: ${result.reason}` );
      if ( photos.length === 0 ) return;
      logger.info( `Auto-importing ${photos.length} photos from USB folder` );
      const {
        resetObservationFlowSlice,
        setPhotoImporterState,
      } = useStore.getState( );
      resetObservationFlowSlice( );
      setPhotoImporterState( {
        photoLibraryUris: photos.map( photo => photo.uri ),
        groupedPhotos: photos.map( photo => ( {
          photos: [{
            image: {
              uri: photo.uri,
              fileName: photo.fileName,
              width: photo.width ?? undefined,
              height: photo.height ?? undefined,
              fileSize: photo.fileSize ?? undefined,
              timestamp: String( photo.timestamp ),
            },
          }],
        } ) ),
      } );
      navigationRef.navigate( "NoBottomTabStackNavigator", { screen: "GroupPhotos" } );
    } catch ( error ) {
      logger.error( "USB auto-import failed", error );
    } finally {
      scanning.current = false;
    }
  }, [onboardingShown, logDiag] );

  useEffect( ( ) => {
    // Report why the hook does or doesn't engage. This runs before the guard
    // below, so it fires even in the cases (native module missing, onboarding
    // not finished) that otherwise leave the feature completely silent — the
    // scan-level skip logs are unreachable when this guard returns early.
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
        scan( );
        interval = setInterval( scan, SCAN_INTERVAL_MS );
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
  }, [scan, onboardingShown, logDiag] );
};

export default useUsbAutoImport;
