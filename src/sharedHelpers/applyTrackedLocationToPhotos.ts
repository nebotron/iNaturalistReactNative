import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import {
  lookupImportedPhotoDeviceUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import type { TrackedPoint } from "sharedHelpers/interpolateTrackedLocation";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
} from "sharedHelpers/interpolateTrackedLocation";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import useStore from "stores/useStore";

const logger = log.extend( "applyTrackedLocationToPhotos" );

export interface TrackedLocationMatch {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  placeGuess?: string | null;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    updateAssetLocation: ( phUri: string, latitude: number, longitude: number ) => Promise<boolean>;
  };
};

// Best-effort: also fills in the location metadata on the original Photos
// library asset (if we know its ph:// identifier), so tracked-location is
// reflected in the Photos app, not just the app's own copy. The native side
// only applies to assets that are missing location, leaving photos that
// already carry their own GPS data untouched.
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
    logger.warn( `Failed to update Photos library asset location for ${phUri}`, error );
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

// Updates an observation's location to the matched coordinates and, as a
// best-effort side effect, writes the matching GPS data into any local photo
// files (and their originating Photos library assets). Remote-only
// observations have no local files to write, but their coordinates are still
// updated. Returns whether the observation was updated.
const applyTrackedLocationToObservation = async (
  realm: Realm,
  observation: RealmObservation,
  match: TrackedLocationMatch,
): Promise<boolean> => {
  const observationPhotos = observation.observationPhotos ?? [];
  const localUris = observationPhotos
    .map( op => Photo.getLocalPhotoUri( op.photo?.localFilePath ) )
    .filter( ( uri ): uri is string => !!uri );

  // Best-effort EXIF + Photos library updates for any local photo files.
  if ( localUris.length > 0 ) {
    const tags = toGpsExifTags( match );
    try {
      await Promise.all( localUris.map( uri => Exify.write( uri, tags ) ) );
    } catch ( error ) {
      logger.error( "Failed to write EXIF GPS data", error );
    }

    const { importedPhotoDeviceUriByLocalUri } = useStore.getState( );
    await Promise.all( observationPhotos.map( op => {
      const localUri = Photo.getLocalPhotoUri( op.photo?.localFilePath );
      const devicePhotoUri = normalizeDevicePhotoUri( op.originalDevicePhotoUri )
        ?? lookupImportedPhotoDeviceUri( importedPhotoDeviceUriByLocalUri, localUri );
      return applyLocationToDevicePhotoLibrary( devicePhotoUri, match );
    } ) );
  }

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
    if ( match.placeGuess != null ) {
      mutableObservation.place_guess = match.placeGuess;
    }
    mutableObservation._updated_at = new Date( );
    mutableObservation.needs_sync = true;
  }, "applying tracked location to observation" );

  return true;
};

// Auto-fills an observation's location from tracked location history when it
// has no location of its own (i.e. its photos carried no GPS EXIF data). Used
// on import/save so a tracked location is applied automatically to both the
// observation and its Photos library assets. No-ops when the observation
// already has a location, when it has no timestamp to match against, when
// tracking recorded no fixes, or when no fix falls within the match window of
// the observation's time. Returns whether a location was applied.
//
// `precomputedUsablePoints` lets a caller importing many observations at once
// filter the (potentially large) point history a single time and reuse it,
// rather than re-filtering per observation. Callers with a single observation
// can omit it.
export const autoApplyTrackedLocationIfMissing = async (
  realm: Realm,
  observation: RealmObservation,
  precomputedUsablePoints?: TrackedPoint[],
): Promise<boolean> => {
  if ( observation.latitude != null && observation.longitude != null ) return false;

  const observedOn = observation.observed_on_string ?? observation.observed_on;
  if ( !observedOn ) {
    logger.info( `No timestamp on observation ${observation.uuid}; skipping tracked location` );
    return false;
  }

  const usablePoints = precomputedUsablePoints ?? filterUsableTrackedPoints(
    realm.objects( "LocationHistoryPoint" ).sorted( "recordedAt" ),
  );
  if ( usablePoints.length === 0 ) {
    logger.info( "No usable tracked location points recorded; skipping tracked location" );
    return false;
  }

  const trackedLocation = interpolateFromUsablePoints(
    usablePoints,
    new Date( observedOn ).getTime(),
  );
  if ( !trackedLocation ) {
    logger.info(
      `No tracked location within match window of ${observedOn} `
      + `for observation ${observation.uuid}`,
    );
    return false;
  }

  logger.info(
    `Applying tracked location ${trackedLocation.latitude},${trackedLocation.longitude} `
    + `to observation ${observation.uuid}`,
  );
  return applyTrackedLocationToObservation( realm, observation, trackedLocation );
};

export default applyTrackedLocationToObservation;
