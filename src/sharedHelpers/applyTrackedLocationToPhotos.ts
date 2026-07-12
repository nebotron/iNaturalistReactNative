import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import { lookupImportedPhotoDeviceUri, normalizeDevicePhotoUri } from "sharedHelpers/getOriginalDevicePhotoUri";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";

const logger = log.extend( "applyTrackedLocationToPhotos" );

export interface TrackedLocationMatch {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    updateAssetLocation: ( phUri: string, latitude: number, longitude: number ) => Promise<boolean>;
  };
};

// Best-effort: also updates the location metadata on the original Photos
// library asset (if we know its ph:// identifier), so tracked-location
// corrections are reflected in the Photos app, not just the app's own copy.
const applyLocationToDevicePhotoLibrary = async (
  originalDevicePhotoUri: string | null | undefined,
  match: TrackedLocationMatch,
): Promise<void> => {
  const phUri = normalizeDevicePhotoUri( originalDevicePhotoUri );
  if ( Platform.OS !== "ios" || !phUri?.startsWith( "ph://" ) || !ImageCropper ) {
    return;
  }
  try {
    await ImageCropper.updateAssetLocation( phUri, match.latitude, match.longitude );
  } catch ( error ) {
    logger.warn( "Failed to update Photos library asset location", error );
  }
};

const toGpsExifTags = ( { latitude, longitude, accuracy }: TrackedLocationMatch ) => ( {
  GPSLatitude: Math.abs( latitude ),
  GPSLatitudeRef: latitude >= 0
    ? "N"
    : "S",
  GPSLongitude: Math.abs( longitude ),
  GPSLongitudeRef: longitude >= 0
    ? "E"
    : "W",
  ...( accuracy != null
    ? { GPSHPositioningError: accuracy }
    : {} ),
} );

// Writes the matched tracked-location GPS data into every local photo file
// belonging to an observation, then updates the observation's own
// latitude/longitude to match. Returns whether anything was written.
const applyTrackedLocationToObservation = async (
  realm: Realm,
  observation: RealmObservation,
  match: TrackedLocationMatch,
): Promise<boolean> => {
  const observationPhotos = observation.observationPhotos ?? [];
  const localUris = observationPhotos
    .map( op => Photo.getLocalPhotoUri( op.photo?.localFilePath ) )
    .filter( ( uri ): uri is string => !!uri );

  if ( localUris.length === 0 ) return false;

  const tags = toGpsExifTags( match );

  try {
    await Promise.all( localUris.map( uri => Exify.write( uri, tags ) ) );
  } catch ( error ) {
    logger.error( "Failed to write EXIF GPS data", error );
    return false;
  }

  const importedPhotoDeviceUriByLocalUri = useStore.getState( ).importedPhotoDeviceUriByLocalUri;
  await Promise.all( observationPhotos.map( op => {
    const localUri = Photo.getLocalPhotoUri( op.photo?.localFilePath );
    const devicePhotoUri = normalizeDevicePhotoUri( op.originalDevicePhotoUri )
      ?? lookupImportedPhotoDeviceUri( importedPhotoDeviceUriByLocalUri, localUri );
    return applyLocationToDevicePhotoLibrary( devicePhotoUri, match );
  } ) );

  const mutableObservation = observation as RealmObservation & {
    _updated_at?: Date;
    needs_sync?: boolean;
  };

  safeRealmWrite( realm, ( ) => {
    mutableObservation.latitude = match.latitude;
    mutableObservation.longitude = match.longitude;
    if ( match.accuracy != null ) {
      mutableObservation.positional_accuracy = match.accuracy;
    }
    mutableObservation._updated_at = new Date( );
    mutableObservation.needs_sync = true;
  }, "applying tracked location to observation" );

  return true;
};

export default applyTrackedLocationToObservation;
