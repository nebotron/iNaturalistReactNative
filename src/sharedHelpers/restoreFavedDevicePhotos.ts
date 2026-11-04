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

const logger = log.extend( "restoreFavedDevicePhotos" );

// A faved observation's photos belong in the user's Photos library. One that
// isn't there (deleted from Photos, e.g. from "Imported to iNaturalist" while
// the observation was unfaved) is saved back from the observation, and the
// copy is remembered in place of the missing asset.

const store = new MMKV( { id: "restored-device-photos" } );
// Device photo URI → the ph:// URI it was saved back to Photos as.
const RESTORED_KEY = "restoredUris";

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

// deviceUris: device photos on faved observations.
// libraryUriFor: the Photos asset each currently maps to.
// Resolves the new assets saved, and whether any save failed and is worth
// trying again.
export const restoreFavedDevicePhotos = async (
  realm: Realm,
  deviceUris: string[],
  libraryUriFor: ( uri: string ) => string,
): Promise<{ saved: string[]; failed: boolean }> => {
  const none = { saved: [], failed: false };
  if ( Platform.OS !== "ios" || !ImageCropper?.existingAssets ) return none;
  // Staged USB photos not yet saved are sweepUsbStaging's to save.
  const candidates = [...new Set( deviceUris )]
    .filter( uri => libraryUriFor( uri ).startsWith( "ph://" ) );
  if ( candidates.length === 0 ) return none;
  let existing: Set<string>;
  try {
    existing = new Set( await ImageCropper.existingAssets( candidates.map( libraryUriFor ) ) );
  } catch ( error ) {
    // Without full access a missing asset can't be told from a hidden one.
    logger.warn( "Could not check which faved photos are still in Photos", error );
    return none;
  }
  const saved: string[] = [];
  let failed = false;
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
      logger.error( "Could not put a faved photo back in Photos", error );
      failed = true;
    }
  }
  if ( saved.length > 0 ) {
    logger.info( `Put ${saved.length} faved photo(s) back in Photos` );
  }
  return { saved, failed };
};
