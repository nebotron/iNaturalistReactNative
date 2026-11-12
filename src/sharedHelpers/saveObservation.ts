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

const saveObservation = async (
  observation: RealmObservation,
  cameraRollUris: string[],
  realm: Realm,
) => {
  await writeExifToCameraRollPhotos( observation, cameraRollUris, {
    latitude: observation.latitude,
    longitude: observation.longitude,
    positional_accuracy: observation.positional_accuracy,
  } );
  const savedObservation = await Observation.saveLocalObservationForUpload( observation, realm );

  // If the observation has no location (no GPS EXIF on its photos), auto-fill
  // it from tracked location history, applying the match to both the
  // observation and the originating Photos library assets.
  if ( savedObservation ) {
    try {
      await autoApplyTrackedLocationIfMissing( realm, savedObservation as RealmObservation );
    } catch ( error ) {
      logger.error( "Failed to auto-apply tracked location on save", error );
    }
  }

  return savedObservation;
};

export default saveObservation;
