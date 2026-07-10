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
  const localUris = photosFromObservation( observation )
    .map( photo => Photo.getLocalPhotoUri( photo?.localFilePath ) )
    .filter( ( uri ): uri is string => !!uri );

  if ( localUris.length === 0 ) return false;

  const tags = toGpsExifTags( match );

  try {
    await Promise.all( localUris.map( uri => Exify.write( uri, tags ) ) );
  } catch ( error ) {
    logger.error( "Failed to write EXIF GPS data", error );
    return false;
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
