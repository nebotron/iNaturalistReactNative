import { NativeModules, Platform } from "react-native";
import type { RealmObservation, RealmObservationPhotoPojo } from "realmModels/types";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "findLibraryOriginal" );

const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    findLibraryOriginal?: ( options: {
      time?: number;
      latitude?: number;
      longitude?: number;
    } ) => Promise<{ uri: string } | null>;
  };
};

// Per photo, for the session.
const found = new Map<string, Promise<string | null>>( );

// The library photo an observation photo was imported from, when the app never
// recorded its uri: the one taken at exactly the observation's time and
// location (see findLibraryOriginal in ImageCropper.m). Only for reading
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
    time: Number.isFinite( time )
      ? time
      : undefined,
    latitude: latitude ?? undefined,
    longitude: longitude ?? undefined,
  };
  const result = ImageCropper.findLibraryOriginal( options )
    .then( match => {
      logger.info( "library original", { uuid: obsPhoto.uuid, match } );
      return match?.uri ?? null;
    } )
    .catch( error => {
      logger.error( "library original lookup failed", error );
      return null;
    } );
  found.set( obsPhoto.uuid, result );
  return result;
};

export default findLibraryOriginal;
