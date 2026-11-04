import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import Photo from "realmModels/Photo";
import type { RealmObservationPhoto } from "realmModels/types";
import { cropOriginalUriFromPath, savedNormalizedCrop } from "sharedHelpers/cropPhotoMetadata";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import { log } from "sharedHelpers/logger";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import { saveLocalPhotoToLibrary } from "sharedHelpers/usbStaging";

const logger = log.extend( "restoreRefavedDevicePhotos" );

// An unfaved observation's photos are filed into "Imported to iNaturalist" for
// the user to delete from Photos. If they do, and then fave the observation
// again, the photo belongs back in their library: this saves a copy from the
// observation and remembers it in place of the deleted asset.

const store = new MMKV( { id: "restored-device-photos" } );
// Library URIs last filed into the album, so a fave can tell a photo that was
// filed (and so may have been deleted) from one that never was.
const FILED_KEY = "filedUris";
// Device photo URI → the ph:// URI it was saved back to Photos as.
const RESTORED_KEY = "restoredUris";

export const getFiledUris = ( ) => new Set<string>(
  JSON.parse( store.getString( FILED_KEY ) ?? "[]" ),
);
export const setFiledUris = ( uris: Iterable<string> ) => (
  store.set( FILED_KEY, JSON.stringify( [...new Set( uris )] ) )
);

const getRestored = ( ): Record<string, string> => JSON.parse(
  store.getString( RESTORED_KEY ) ?? "{}",
);

// The asset a device photo was restored as, if it was.
export const restoredUriFor = ( deviceUri: string ): string | undefined => (
  getRestored( )[deviceUri]
);

const { ImageCropper } = NativeModules as {
  ImageCropper?: { existingAssets?: ( phUris: string[] ) => Promise<string[]> };
};

// The observation photo carrying this device photo, for something to save.
// Stored URIs may lack the ph:// that normalizeDevicePhotoUri adds.
const findObsPhoto = ( realm: Realm, deviceUri: string ) => (
  realm.objects<RealmObservationPhoto>( "ObservationPhoto" )
    .filtered( "originalDevicePhotoUri IN $0", [deviceUri, deviceUri.replace( /^ph:\/\//, "" )] )[0]
);

const restoreOne = async (
  realm: Realm,
  deviceUri: string,
): Promise<string | null | undefined> => {
  const photo = findObsPhoto( realm, deviceUri )?.photo;
  // Nothing to save for a photo no longer on any observation.
  const fallback = photo && Photo.displayCropSourcePhoto( photo );
  if ( !photo || !fallback ) return null;
  // The uncropped original with the crop over it, as the device had it plus
  // the edit; else the observation's photo as it is.
  const original = cropOriginalUriFromPath( photo.cropOriginalLocalFilePath );
  const crop = original
    ? savedNormalizedCrop( photo ) ?? undefined
    : undefined;
  const local = await ensureLocalImageForCrop( original || fallback, "original" );
  return enqueuePhotoLibraryWrite(
    ( ) => saveLocalPhotoToLibrary( stripFilePrefix( local ), crop ),
  );
};

// deviceUris: device photos on observations just faved again.
// libraryUriFor: the Photos asset each currently maps to.
// Resolves the device URIs whose restoration should be tried again later, and
// the new assets saved.
export const restoreRefavedDevicePhotos = async (
  realm: Realm,
  deviceUris: string[],
  libraryUriFor: ( uri: string ) => string,
): Promise<{ retry: string[]; saved: string[] }> => {
  if ( deviceUris.length === 0 ) return { retry: [], saved: [] };
  if ( Platform.OS !== "ios" || !ImageCropper?.existingAssets ) {
    return { retry: [], saved: [] };
  }
  const candidates = deviceUris.filter( uri => libraryUriFor( uri ).startsWith( "ph://" ) );
  let existing: Set<string>;
  try {
    existing = new Set( await ImageCropper.existingAssets( candidates.map( libraryUriFor ) ) );
  } catch ( error ) {
    // Without full access a missing asset can't be told from a hidden one.
    logger.warn( "Could not check which refaved photos are still in Photos", error );
    return { retry: [], saved: [] };
  }
  const retry: string[] = [];
  const saved: string[] = [];
  const missing = candidates.filter( uri => !existing.has( libraryUriFor( uri ) ) );
  for ( const deviceUri of missing ) {
    if ( realm.isClosed ) break;
    try {
      // eslint-disable-next-line no-await-in-loop
      const uri = await restoreOne( realm, deviceUri );
      if ( uri ) {
        store.set( RESTORED_KEY, JSON.stringify( { ...getRestored( ), [deviceUri]: uri } ) );
        saved.push( uri );
      }
    } catch ( error ) {
      logger.error( "Could not put a refaved photo back in Photos", error );
      retry.push( deviceUri );
    }
  }
  if ( saved.length > 0 ) {
    logger.info( `Put ${saved.length} refaved photo(s) back in Photos` );
  }
  return { retry, saved };
};
