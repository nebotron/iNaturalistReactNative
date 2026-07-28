import { NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "existingDevicePhotoUris" );

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    existingPhotoAssetUris?: ( phUris: string[] ) => Promise<string[]>;
  };
};

// Narrows a list of device photo library URIs to the ones that still resolve to
// a real asset. A stored ph:// identifier outlives the photo it points at — the
// asset may have been deleted from Photos (by us or by the user) or orphaned by
// a device restore that reassigned local identifiers. Those ghosts can't render
// a thumbnail and can't be deleted (PHAsset fetch returns nothing for them), so
// anything that shows or acts on stored URIs should drop them first.
//
// iOS only; elsewhere, and on builds without the native helper, the list is
// returned unchanged rather than pretending everything is gone.
const filterExistingDevicePhotoUris = async ( uris: string[] ): Promise<string[]> => {
  if ( uris.length === 0 ) {
    return uris;
  }
  if ( Platform.OS !== "ios" || !ImageCropper?.existingPhotoAssetUris ) {
    return uris;
  }
  try {
    const existing = await ImageCropper.existingPhotoAssetUris( uris );
    if ( !Array.isArray( existing ) ) {
      return uris;
    }
    if ( existing.length < uris.length ) {
      logger.info(
        `Dropped ${uris.length - existing.length} device photo URI(s) `
        + `of ${uris.length} that no longer resolve to a library asset`,
      );
    }
    return existing;
  } catch ( error ) {
    logger.warn( "Failed to check which device photo URIs still exist", error );
    return uris;
  }
};

export default filterExistingDevicePhotoUris;
