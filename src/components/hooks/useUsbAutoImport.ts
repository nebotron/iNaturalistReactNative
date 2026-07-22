import { navigationRef } from "navigation/navigationUtils";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import {
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

  const scan = useCallback( async ( ) => {
    if ( !isUsbImportSupported( ) || scanning.current ) return;
    if ( !onboardingShown || !navigationRef.isReady( ) ) return;
    // Don't clobber an import/grouping session that's already underway: if the
    // user is still working through a previous batch (groupedPhotos non-empty,
    // cleared once observations are created), leave it be until they finish.
    if ( useStore.getState( ).groupedPhotos.length > 0 ) return;
    scanning.current = true;
    try {
      const photos = await importNewUsbImages( );
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
  }, [onboardingShown] );

  useEffect( ( ) => {
    if ( !isUsbImportSupported( ) || !onboardingShown ) return undefined;

    let interval: ReturnType<typeof setInterval> | undefined;
    const stopPolling = ( ) => {
      if ( interval ) clearInterval( interval );
      interval = undefined;
    };
    const startPolling = async ( ) => {
      stopPolling( );
      // Nothing to watch until the user has chosen a folder; don't wake the JS
      // thread on an interval for the many users who never set one up.
      const folder = await getUsbFolderName( );
      if ( !folder ) return;
      scan( );
      interval = setInterval( scan, SCAN_INTERVAL_MS );
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
  }, [scan, onboardingShown] );
};

export default useUsbAutoImport;
