import * as Exify from "@lodev09/react-native-exify";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPojo } from "realmModels/types";
import {
  lookupImportedPhotoDeviceUri,
  normalizeDevicePhotoUri,
} from "sharedHelpers/getOriginalDevicePhotoUri";
import type { TrackedPoint } from "sharedHelpers/interpolateTrackedLocation";
import {
  filterUsableTrackedPoints,
  interpolateFromUsablePoints,
} from "sharedHelpers/interpolateTrackedLocation";
import { drainTrackedLocationFixes } from "sharedHelpers/locationHistoryTracker";
import { log } from "sharedHelpers/logger";
import {
  clearPhotoLibraryWriteFailure,
  enqueuePhotoLibraryWrite,
  isInPhotoLibraryWriteCooldown,
  recordPhotoLibraryWriteFailure,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
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

// Native Photos-library writes can trigger a system confirmation dialog that
// silently never presents under certain modal states, leaving the native
// promise unresolved forever (see ImageCropper.m). That's a native-side bug
// worth fixing at the source, but this timeout is the backstop that keeps a
// stuck native call from hanging the UI (e.g. the LocationHistory screen's
// "Apply Tracked Location" button spinner) indefinitely regardless.
const DEVICE_PHOTO_UPDATE_TIMEOUT_MS = 15_000;

const withTimeout = <T, >( promise: Promise<T>, ms: number, label: string ): Promise<T> => (
  new Promise<T>( ( resolve, reject ) => {
    const timer = setTimeout(
      ( ) => reject( new Error( `${label} timed out after ${ms}ms` ) ),
      ms,
    );
    promise
      .then( value => {
        clearTimeout( timer );
        resolve( value );
      } )
      .catch( error => {
        clearTimeout( timer );
        reject( error );
      } );
  } )
);

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
  // Shares a cooldown with device-photo deletion: both hit the same
  // PHPhotoLibrary confirmation machinery, and a recent timeout on either one
  // means it's likely wedged for the whole device (see
  // promptDeleteOriginalDevicePhotos.ts).
  if ( isInPhotoLibraryWriteCooldown( ) ) {
    logger.warn(
      `Skipped updateAssetLocation for ${phUri}: still in Photos-library write cooldown`,
    );
    return;
  }
  try {
    // Serialized with deletions (and other location updates) so only one
    // native Photos-library write is ever in flight — see
    // enqueuePhotoLibraryWrite in promptDeleteOriginalDevicePhotos.ts.
    await enqueuePhotoLibraryWrite( ( ) => withTimeout(
      ImageCropper.updateAssetLocation( phUri, match.latitude, match.longitude ),
      DEVICE_PHOTO_UPDATE_TIMEOUT_MS,
      `updateAssetLocation for ${phUri}`,
    ) );
    clearPhotoLibraryWriteFailure( );
  } catch ( error ) {
    logger.warn( `Failed to update Photos library asset location for ${phUri}`, error );
    if ( error instanceof Error && error.message.includes( "timed out" ) ) {
      recordPhotoLibraryWriteFailure( );
    }
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
  if ( observation.latitude != null && observation.longitude != null ) {
    logger.info(
      `Observation ${observation.uuid} already has a location `
      + `(${observation.latitude},${observation.longitude}); skipping tracked location`,
    );
    return false;
  }

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
  const applied = await applyTrackedLocationToObservation( realm, observation, trackedLocation );

  // Confirm the write actually stuck by reading the field back, rather than
  // trusting the log line above: this is the one place we can directly catch
  // a later write (a stale save, a remote upsert) clobbering it back to null.
  const confirmed = realm.objectForPrimaryKey<RealmObservation>( "Observation", observation.uuid );
  logger.info(
    `Confirmed location for observation ${observation.uuid}: `
    + `${confirmed?.latitude},${confirmed?.longitude}`,
  );

  return applied;
};

// Saves each observation, then auto-fills tracked location for any that ended
// up without one, reusing a single accuracy-filtered point set across all of
// them. Shared by every place that persists freshly-created observations, so
// the location auto-fill can't drift out of sync between call sites the way
// it has twice before (see git history on this file). Returns a map of uuid
// to the location that was applied, for callers that need to mirror the fill
// back onto their own in-memory copies (e.g. for a CV prefetch cache key).
export const saveObservationsAndApplyTrackedLocation = async (
  observations: RealmObservationPojo[],
  realm: Realm,
): Promise<Record<string, TrackedLocationMatch>> => {
  const saveResults = await Promise.allSettled(
    observations.map( obs => Observation.saveLocalObservationForUpload( obs, realm ) ),
  );
  saveResults.forEach( ( result, idx ) => {
    if ( result.status === "rejected" ) {
      logger.error(
        `Failed to save observation ${observations[idx]?.uuid}`,
        result.reason,
      );
    }
  } );

  const trackedLocationByUuid: Record<string, TrackedLocationMatch> = {};
  try {
    const missingLocationObs = observations
      .filter( obs => obs.latitude == null || obs.longitude == null );
    if ( missingLocationObs.length > 0 ) {
      // The newest fixes may still be sitting in the native buffer waiting for
      // the tracker's drain timer, and they're the ones most likely to match a
      // photo the user just took.
      await drainTrackedLocationFixes( realm );
      // Filter the (potentially large) point history once and reuse it for
      // every observation, rather than re-filtering per observation.
      const usablePoints = filterUsableTrackedPoints(
        realm.objects( "LocationHistoryPoint" ).sorted( "recordedAt" ),
      );
      logger.info(
        `Auto-filling tracked location: ${missingLocationObs.length} observation(s) `
        + `missing location, ${usablePoints.length} usable tracked point(s)`,
      );
      await Promise.all( missingLocationObs.map( async obs => {
        try {
          const savedObs = realm.objectForPrimaryKey<RealmObservation>( "Observation", obs.uuid );
          if ( !savedObs ) return;
          const applied = await autoApplyTrackedLocationIfMissing( realm, savedObs, usablePoints );
          if ( applied ) {
            trackedLocationByUuid[obs.uuid] = {
              latitude: savedObs.latitude as number,
              longitude: savedObs.longitude as number,
              accuracy: savedObs.positional_accuracy ?? null,
            };
          }
        } catch ( error ) {
          logger.error( `Failed to auto-apply tracked location to ${obs.uuid}`, error );
        }
      } ) );
    }
  } catch ( error ) {
    logger.error( "Failed to auto-apply tracked location while saving observations", error );
  }

  return trackedLocationByUuid;
};

export default applyTrackedLocationToObservation;
