import { navigationRef } from "navigation/navigationUtils";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";
import { useOnboardingShown } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import {
  importNewUsbImages,
  isUsbImportSupported,
} from "sharedHelpers/usbStorage";
import useStore from "stores/useStore";

const logger = log.extend( "useUsbAutoImport" );

// Checks the user's chosen USB folder (see UsbImportSetting) on launch and
// whenever the app returns to the foreground — the moments a just-plugged-in
// drive becomes visible, since iOS offers no attach notification. New images
// are copied into app storage and dropped into the GroupPhotos flow, same as
// photos shared into the app (see PhotoSharing).
const useUsbAutoImport = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const scanning = useRef( false );

  const scan = useCallback( async ( ) => {
    if ( !isUsbImportSupported( ) || scanning.current ) return;
    if ( !onboardingShown || !navigationRef.isReady( ) ) return;
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
    scan( );
    const subscription = AppState.addEventListener( "change", nextAppState => {
      if ( nextAppState === "active" ) scan( );
    } );
    return ( ) => subscription.remove( );
  }, [scan] );
};

export default useUsbAutoImport;
