import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import {
  CameraRoll,
  iosReadGalleryPermission,
} from "@react-native-camera-roll/camera-roll";
import { isVideoNode } from "components/PhotoImporter/helpers/videoImportHelpers";
import { Platform } from "react-native";
import type Realm from "realm";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { PRELOAD_LOOKAHEAD } from "sharedHelpers/imageCropPreload";
import { log } from "sharedHelpers/logger";
import {
  canPreloadPickerPhoto,
  preloadPickerPhoto,
} from "sharedHelpers/pickerCropPreload";
import { getRemovedGroupPhotoUris } from "sharedHelpers/removedGroupPhotoUris";
import { devicePhotoKey, listStagedPhotoNodes } from "sharedHelpers/usbStaging";

type PhotoNode = PhotoIdentifier["node"];

const logger = log.extend( "preloadNewestPickerPhotos" );

// How many of the newest library photos to look through for ones not yet
// imported, as the picker's first page does.
const LIBRARY_PAGE = 60;

// The device URI a picker photo is recorded under once imported, which is what
// the picker hides it by.
export const getDeviceUriFromNode = ( node: PhotoNode ): string | null => {
  // A staged SD card photo (see usbStaging.ts), not a library asset
  if ( Platform.OS === "ios" && !node.image.uri.startsWith( "file://" ) ) {
    if ( !node.id ) {
      return null;
    }
    return normalizeDevicePhotoUri( `ph://${node.id}` );
  }
  return normalizeDevicePhotoUri( node.image.uri );
};

export const isPickerPreloadable = ( node: PhotoNode ) => !isVideoNode( node )
  && !( node.image.filename ?? "" ).toLowerCase( ).endsWith( ".gif" )
  && canPreloadPickerPhoto( node.image.uri );

// Prepares the photos the picker will open on -- its newest, minus the ones it
// hides as already imported -- before it is opened: after a USB import lands
// photos in it, and after a Group Photos import takes the last batch out of it.
// The picker keeps preparing whatever is on top once it is open; these are the
// same photos, so they are prepared once (see pickerCropPreload).
export async function preloadNewestPickerPhotos( realm: Realm ): Promise<void> {
  if ( Platform.OS !== "ios" || PRELOAD_LOOKAHEAD <= 0 || realm.isClosed ) return;
  try {
    // Checked, never requested: this runs without the user asking for Photos.
    const status = await iosReadGalleryPermission( "readWrite" );
    const library = status === "granted" || status === "limited"
      ? ( await CameraRoll.getPhotos( {
        first: LIBRARY_PAGE,
        assetType: "Photos",
        include: ["filename"],
      } ) ).edges.map( edge => edge.node )
      : [];
    const staged = await listStagedPhotoNodes( );
    if ( realm.isClosed ) return;
    const hidden = new Set( [
      ...getPreviouslyUploadedDevicePhotoUrisSet( realm ),
      ...getRemovedGroupPhotoUris( ),
    ].map( devicePhotoKey ) );
    const isHidden = ( node: PhotoNode ) => {
      const uri = getDeviceUriFromNode( node );
      return !!uri && hidden.has( devicePhotoKey( uri ) );
    };
    [...library, ...staged]
      .sort( ( a, b ) => b.timestamp - a.timestamp )
      .filter( node => isPickerPreloadable( node ) && !isHidden( node ) )
      .slice( 0, PRELOAD_LOOKAHEAD )
      .forEach( node => preloadPickerPhoto( node.image.uri, node.image.filename ) );
  } catch ( error ) {
    logger.error( "Could not preload the newest photos for the picker", error );
  }
}
