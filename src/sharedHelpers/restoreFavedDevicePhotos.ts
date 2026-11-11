import { exists } from "@dr.pogodin/react-native-fs";
import { NativeModules, Platform } from "react-native";
import { MMKV } from "react-native-mmkv";
import type Realm from "realm";
import Photo from "realmModels/Photo";
import type {
  RealmObservation, RealmObservationPhoto, RealmPhoto,
} from "realmModels/types";
import { cropOriginalUriFromPath, savedNormalizedCrop } from "sharedHelpers/cropPhotoMetadata";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
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
// ObservationPhoto is embedded, so it can only be reached through its
// Observation: querying it directly threw "You cannot query an embedded
// object" for every missing photo (156 errors in a day's log).
const findObsPhoto = (
  realm: Realm,
  deviceUri: string,
): RealmObservationPhoto | undefined => {
  const uris = [deviceUri, deviceUri.replace( /^ph:\/\//, "" )];
  const observation = realm.objects<RealmObservation>( "Observation" )
    .filtered( "ANY observationPhotos.originalDevicePhotoUri IN $0", uris )[0];
  return observation?.observationPhotos
    ?.find( op => uris.includes( op.originalDevicePhotoUri ?? "" ) );
};

const fileExists = async ( uri: string | null | undefined ): Promise<boolean> => (
  !!uri && exists( stripFilePrefix( uri ) ).catch( ( ) => false )
);

// What to save for a missing photo, and the crop to apply over it. Synced
// observations have their photoUploads files swept (clearSyncedMediaForUpload)
// while Realm keeps the paths, so a local file is only used if it's still
// there: handing the cropper a deleted crop original failed every save of a
// cropped, uploaded photo ("Could not render cropped image", 2,071 times in a
// day) and was retried on every Realm write.
const restoreSource = async (
  photo: RealmPhoto,
): Promise<{ uri: string; crop?: NormalizedCrop } | null> => {
  // The uncropped original with the crop over it, as the device had it plus
  // the edit.
  const original = cropOriginalUriFromPath( photo.cropOriginalLocalFilePath );
  if ( await fileExists( original ) ) {
    return { uri: original as string, crop: savedNormalizedCrop( photo ) ?? undefined };
  }
  // Else the observation's photo as it is: already cropped, locally or as
  // uploaded.
  const local = Photo.getLocalPhotoUri( photo.localFilePath );
  if ( await fileExists( local ) ) return { uri: local as string };
  const remote = Photo.displayOriginalPhoto( photo.url );
  return remote
    ? { uri: remote }
    : null;
};

const restoreOne = async (
  realm: Realm,
  deviceUri: string,
): Promise<string | null | undefined> => {
  const photo = findObsPhoto( realm, deviceUri )?.photo;
  // Nothing to save for a photo no longer on any observation.
  const source = photo && await restoreSource( photo );
  if ( !source ) return null;
  const local = await ensureLocalImageForCrop( source.uri, "original" );
  return enqueuePhotoLibraryWrite(
    ( ) => saveLocalPhotoToLibrary( stripFilePrefix( local ), source.crop ),
  );
};

// A photo whose save keeps failing for its own reasons (an undecodable file, a
// download that won't come) is tried this many times per launch, not on every
// Realm write for as long as the app is open.
const MAX_FAILURES_PER_LAUNCH = 3;
const failures = new Map<string, number>( );

const isLibraryBusy = ( error: unknown ): boolean => (
  ( error as { code?: string } | undefined )?.code === "PHOTOS_LIBRARY_BUSY"
);

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
  const missing = candidates.filter( uri => !existing.has( libraryUriFor( uri ) )
    && ( failures.get( uri ) ?? 0 ) < MAX_FAILURES_PER_LAUNCH );
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
      failed = true;
      // A busy library refused without trying; that's no mark against the photo.
      if ( !isLibraryBusy( error ) ) {
        const count = ( failures.get( deviceUri ) ?? 0 ) + 1;
        failures.set( deviceUri, count );
        logger.error(
          `Could not put a faved photo back in Photos (try ${count}/${MAX_FAILURES_PER_LAUNCH})`,
          error,
        );
      }
    }
  }
  if ( saved.length > 0 ) {
    logger.info( `Put ${saved.length} faved photo(s) back in Photos` );
  }
  return { saved, failed };
};
