import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import { photosFromObservation } from "components/ObservationsFlashList/util";
import type Realm from "realm";
import Photo from "realmModels/Photo";
import type { RealmObservation } from "realmModels/types";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const logger = log.extend( "applyTrackedLocationToPhotos" );

export interface TrackedLocationMatch {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

// Matches the signed-value convention used elsewhere in this codebase
// (saveObservation.ts, MediaViewer.tsx) for writing GPS tags via Exify.write
const toGpsExifTags = ( { latitude, longitude, accuracy }: TrackedLocationMatch ): ExifTags => ( {
  GPSLatitude: latitude,
  GPSLongitude: longitude,
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
  const localUris = photosFromObservation( observation )
    .map( photo => Photo.getLocalPhotoUri( photo?.localFilePath ) )
    .filter( ( uri ): uri is string => !!uri );

  if ( localUris.length > 0 ) {
    const tags = toGpsExifTags( match );

    try {
      await Promise.all( localUris.map( uri => Exify.write( uri, tags ) ) );
    } catch ( error ) {
      logger.error( "Failed to write EXIF GPS data", error );
      return false;
    }
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
    mutableObservation._updated_at = new Date( );
    mutableObservation.needs_sync = true;
  }, "applying tracked location to observation" );

  return true;
};

export default applyTrackedLocationToObservation;
