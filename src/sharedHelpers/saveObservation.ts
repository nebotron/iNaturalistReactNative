import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import { Platform } from "react-native";
import type Realm from "realm";
import Observation from "realmModels/Observation";
import type { RealmObservation } from "realmModels/types";
import {
  applyLocationToDevicePhotoLibrary,
  autoApplyTrackedLocationIfMissing,
} from "sharedHelpers/applyTrackedLocationToPhotos";
import exifUri from "sharedHelpers/exifUri";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "saveObservation.ts" );

const writeExifToCameraRollPhotos = async (
  observation: RealmObservation,
  cameraRollUris: string[],
  exif: {
    latitude?: number | null;
    longitude?: number | null;
    positional_accuracy?: number | null;
  },
) => {
  if ( !cameraRollUris || cameraRollUris.length === 0 || !observation ) {
    return;
  }

  // eslint-disable-next-line camelcase
  const { latitude, longitude, positional_accuracy } = exif;

  // On iOS the camera's library copies are ph:// assets, and Exify can't edit
  // one in place: it writes a brand-new asset with the new metadata, so every
  // save left a second copy of each photo in the user's library. Set the
  // asset's location through PhotoKit instead, which changes the existing
  // asset (and only fills it in when the photo has none of its own).
  if ( Platform.OS === "ios" ) {
    if ( latitude == null || longitude == null ) return;
    await Promise.all( cameraRollUris.map( uri => applyLocationToDevicePhotoLibrary( uri, {
      latitude,
      longitude,
      // eslint-disable-next-line camelcase
      accuracy: positional_accuracy,
    } ) ) );
    return;
  }

  const exifToWrite: ExifTags = {
    GPSLatitude: latitude,
    GPSLongitude: longitude,
    // eslint-disable-next-line camelcase
    GPSHPositioningError: positional_accuracy,
  };

  // Update all photos taken via the app with the new fetched location.
  const results = await Promise.allSettled(
    cameraRollUris.map( uri => Exify.write( exifUri( uri ), exifToWrite ) ),
  );
  results
    .filter( ( r ): r is PromiseRejectedResult => r.status === "rejected" )
    .forEach( r => logger.error( "Failed to write EXIF to camera roll photo:", r.reason ) );
};

// Saves still filling in their location, by observation uuid
const finishingSaves = new Map<string, Promise<void>>( );

// Resolves once the location work of any save of this observation is done.
// The uploader waits on it, so an observation saved a moment ago doesn't go
// up before its tracked location is filled in.
export const awaitObservationSaveFinished = (
  uuid: string | undefined,
): Promise<void> => ( uuid && finishingSaves.get( uuid ) ) || Promise.resolve( );

// The location half of a save: written to the device photos the camera took,
// and filled in from tracked location history for an observation that has
// none. Never rejects.
const finishSave = async (
  observation: RealmObservation,
  cameraRollUris: string[],
  realm: Realm,
  savedObservation: RealmObservation | null | undefined,
) => {
  try {
    await writeExifToCameraRollPhotos( observation, cameraRollUris, {
      latitude: observation.latitude,
      longitude: observation.longitude,
      positional_accuracy: observation.positional_accuracy,
    } );
  } catch ( error ) {
    logger.error( "Failed to write location to camera roll photos on save", error );
  }
  // If the observation has no location (no GPS EXIF on its photos), auto-fill
  // it from tracked location history, applying the match to both the
  // observation and the originating Photos library assets.
  if ( savedObservation && !realm.isClosed && savedObservation.isValid?.( ) !== false ) {
    try {
      await autoApplyTrackedLocationIfMissing( realm, savedObservation );
    } catch ( error ) {
      logger.error( "Failed to auto-apply tracked location on save", error );
    }
  }
};

interface SaveOptions {
  // Return once the observation is in Realm, and write its location to the
  // device's photos (and fill it in from tracked location) afterwards. Those
  // are Photos library writes, slow enough that waiting on them made picking
  // a species stall before the next observation or screen came up.
  locationInBackground?: boolean;
}

const saveObservation = async (
  observation: RealmObservation,
  cameraRollUris: string[],
  realm: Realm,
  { locationInBackground = false }: SaveOptions = {},
) => {
  const savedObservation = await Observation.saveLocalObservationForUpload(
    observation,
    realm,
  ) as RealmObservation | null | undefined;
  const { uuid } = observation;
  const finished = finishSave( observation, cameraRollUris, realm, savedObservation );
  if ( uuid ) {
    finishingSaves.set( uuid, finished );
    finished.then( ( ) => {
      if ( finishingSaves.get( uuid ) === finished ) finishingSaves.delete( uuid );
    } );
  }
  if ( !locationInBackground ) await finished;
  return savedObservation;
};

export default saveObservation;
