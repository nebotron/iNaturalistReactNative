import { NativeModules, Platform } from "react-native";
import type { RealmObservation, RealmObservationPhotoPojo } from "realmModels/types";
import { log } from "sharedHelpers/logger";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const logger = log.extend( "findLibraryOriginal" );

interface Query {
  uuid: string;
  deviceUri: string | null;
  time?: number;
  latitude?: number;
  longitude?: number;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    findLibraryOriginal?: ( options: Omit<Query, "uuid" | "deviceUri"> ) => Promise<{
      uri?: string;
      inSecond?: number;
      atLocation?: number;
    } | null>;
  };
};

// Per photo, for the session.
const found = new Map<string, Promise<string | null>>( );

// What to look a photo's library original up by, read while the Realm objects
// are still valid.
export const libraryOriginalQuery = (
  obsPhoto: RealmObservationPhotoPojo,
  observation: RealmObservation,
): Query => {
  const time = Date.parse( observation.time_observed_at ?? observation.observed_on_string ?? "" );
  return {
    uuid: obsPhoto.uuid,
    deviceUri: obsPhoto.originalDevicePhotoUri ?? null,
    time: Number.isFinite( time )
      ? time
      : undefined,
    latitude: observation.privateLatitude ?? observation.latitude ?? undefined,
    longitude: observation.privateLongitude ?? observation.longitude ?? undefined,
  };
};

// The library photo an observation photo was imported from, when the app never
// recorded its uri or the one recorded is gone: the one taken at exactly the
// observation's time and location, or the only one taken in that second
// (see findLibraryOriginal in ImageCropper.m). Only for reading metadata — not saved as
// originalDevicePhotoUri, which would let a wrong match be offered for deletion.
const findLibraryOriginal = ( { uuid, deviceUri, ...options }: Query ): Promise<string | null> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.findLibraryOriginal ) return Promise.resolve( null );
  const cached = found.get( uuid );
  if ( cached ) return cached;
  const result = ImageCropper.findLibraryOriginal( options )
    .then( match => {
      logger.info( `library_original ${match?.uri
        ? "found"
        : "none"} recorded=${!!deviceUri} time=${!!options.time} `
        + `location=${options.latitude !== undefined} in_second=${match?.inSecond ?? "-"} `
        + `at_location=${match?.atLocation ?? "-"}` );
      return match?.uri ?? null;
    } )
    .catch( error => {
      logger.error( "library_original lookup failed", error );
      return null;
    } );
  found.set( uuid, result );
  return result;
};

// Camera settings from the photo's library original: the one recorded, else
// the one matched to it.
export const readLibraryCameraInfo = async ( query: Query ): Promise<PhotoCameraInfo | null> => {
  const recorded = query.deviceUri
    ? await readCameraInfo( query.deviceUri )
    : null;
  if ( recorded ) return recorded;
  const match = await findLibraryOriginal( query );
  return match && match !== query.deviceUri
    ? readCameraInfo( match )
    : null;
};
