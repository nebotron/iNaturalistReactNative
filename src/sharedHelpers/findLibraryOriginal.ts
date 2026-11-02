import { NativeModules, Platform } from "react-native";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPhotoPojo } from "realmModels/types";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "findLibraryOriginal" );

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    findLibraryOriginal?: ( options: {
      uri?: string;
      time?: number;
      latitude?: number;
      longitude?: number;
    } ) => Promise<{ uri: string } | null>;
  };
};

// Per photo, for the session; the lookup compares dozens of library photos.
const found = new Map<string, Promise<string | null>>( );
let queue: Promise<unknown> = Promise.resolve( );

// The library photo an observation photo was imported from, when the app never
// recorded its uri: matched by the observation's time and location and the
// photo's content (see findLibraryOriginal in ImageCropper.m). Only for reading
// metadata — not saved as originalDevicePhotoUri, which would let a wrong match
// be offered for deletion.
const findLibraryOriginal = (
  obsPhoto: RealmObservationPhotoPojo,
  observation: RealmObservation,
): Promise<string | null> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.findLibraryOriginal ) return Promise.resolve( null );
  const cached = found.get( obsPhoto.uuid );
  if ( cached ) return cached;
  const time = Date.parse( observation.time_observed_at ?? observation.observed_on_string ?? "" );
  const latitude = observation.privateLatitude ?? observation.latitude;
  const longitude = observation.privateLongitude ?? observation.longitude;
  const options = {
    uri: Photo.getLocalPhotoUri( obsPhoto.photo?.cropOriginalLocalFilePath ?? undefined )
      || Photo.getLocalPhotoUri( obsPhoto.photo?.localFilePath ?? undefined )
      || Photo.displayMediumPhoto( obsPhoto.photo?.url ?? undefined )
      || undefined,
    time: Number.isFinite( time )
      ? time
      : undefined,
    latitude: latitude ?? undefined,
    longitude: longitude ?? undefined,
  };
  // One at a time: each lookup computes feature prints for up to 60 photos.
  const result = queue.then( ( ) => ImageCropper?.findLibraryOriginal?.( options ) )
    .then( match => {
      logger.info( "library original", { uuid: obsPhoto.uuid, match } );
      return match?.uri ?? null;
    } )
    .catch( error => {
      logger.error( "library original lookup failed", error );
      return null;
    } );
  queue = result;
  found.set( obsPhoto.uuid, result );
  return result;
};

export default findLibraryOriginal;
