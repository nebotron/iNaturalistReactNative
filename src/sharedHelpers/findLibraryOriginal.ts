import { copyFile } from "@dr.pogodin/react-native-fs";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { NativeModules, Platform } from "react-native";
import type Realm from "realm";
import type { RealmObservation, RealmObservationPhotoPojo } from "realmModels/types";
import { log } from "sharedHelpers/logger";
import type { PhotoCameraInfo } from "sharedHelpers/photoCameraInfo";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import { readableUriForDevicePhoto } from "sharedHelpers/usbStaging";

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
      shifted?: number;
      sameShot?: boolean;
      onlyDistance?: number;
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
  // An obscured observation synced without its private coordinates only has
  // the randomized public point, often kilometres off, which ruled out the
  // photo taken at its time; matched like an observation without a location.
  // (Before upload, latitude is still the one the user set.)
  const obscured = !!observation._synced_at && (
    ["obscured", "private"].includes( observation.geoprivacy ?? "" )
    || ["obscured", "private"].includes( observation.taxon_geoprivacy ?? "" ) );
  return {
    uuid: obsPhoto.uuid,
    deviceUri: obsPhoto.originalDevicePhotoUri
      ? readableUriForDevicePhoto( obsPhoto.originalDevicePhotoUri )
      : null,
    time: Number.isFinite( time )
      ? time
      : undefined,
    latitude: observation.privateLatitude ?? ( obscured
      ? undefined
      : observation.latitude ) ?? undefined,
    longitude: observation.privateLongitude ?? ( obscured
      ? undefined
      : observation.longitude ) ?? undefined,
  };
};

// The observation photo shown at a local uri or remote url, with what to look
// its library original up by.
export const findObservationPhoto = (
  realm: Realm,
  { uri, url }: { uri?: string | null; url?: string | null },
): { obsPhoto: RealmObservationPhotoPojo; library: Query } | null => {
  const fileName = uri?.split( "/" ).pop( );
  const query = url
    ? ["ANY observationPhotos.photo.url == $0", url]
    : fileName && ["ANY observationPhotos.photo.localFilePath ENDSWITH $0", fileName];
  if ( !query ) return null;
  const observation = realm.objects<RealmObservation>( "Observation" )
    .filtered( query[0], query[1] )[0];
  const obsPhoto = observation?.observationPhotos?.find( op => ( url
    ? op.photo?.url === url
    : op.photo?.localFilePath?.endsWith( fileName as string ) ) );
  return obsPhoto
    ? { obsPhoto, library: libraryOriginalQuery( obsPhoto, observation ) }
    : null;
};

// The library photo an observation photo was imported from, when the app never
// recorded its uri or the one recorded is gone: the one taken at exactly the
// observation's time and location, or the only one taken in that second, else
// the one at its location taken a time-zone shift away (see findLibraryOriginal
// in ImageCropper.m). Only for reading metadata — not saved as
// originalDevicePhotoUri, which would let a wrong match be offered for deletion.
const findLibraryOriginal = ( { uuid, deviceUri, ...options }: Query ): Promise<string | null> => {
  if ( Platform.OS !== "ios" || !ImageCropper?.findLibraryOriginal ) return Promise.resolve( null );
  const cached = found.get( uuid );
  if ( cached ) return cached;
  const result = ImageCropper.findLibraryOriginal( options )
    .then( match => {
      // A miss with no candidates at all is the common case and says nothing.
      if ( !match?.uri && !match?.inSecond && !match?.atLocation ) return null;
      logger.info( `library_original ${match?.uri
        ? "found"
        : "none"} recorded=${!!deviceUri} time=${!!options.time} `
        + `location=${options.latitude !== undefined} in_second=${match?.inSecond ?? "-"} `
        + `at_location=${match?.atLocation ?? "-"} shifted=${match?.shifted ?? "-"}`
        + `${match?.sameShot
          ? " same_shot"
          : ""}${match?.onlyDistance !== undefined
          ? ` only_m=${match.onlyDistance}`
          : ""}` );
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

const extensionOf = ( path: string ) => {
  const name = path.split( "?" )[0].split( "/" ).pop( ) ?? "";
  const dot = name.lastIndexOf( "." );
  return dot > 0
    ? name.slice( dot + 1 ).toLowerCase( )
    : "jpg";
};

// Copies one device photo uri to a new temp file, or resolves null when it is
// gone or unreadable.
const copyDevicePhoto = async ( uri: string, tempBase: string ): Promise<string | null> => {
  try {
    let source = uri;
    if ( uri.startsWith( "ph://" ) ) {
      const data = await CameraRoll.iosGetImageDataById( uri.slice( "ph://".length ) );
      source = data?.node?.image?.filepath ?? "";
      if ( !source ) return null;
    }
    const dest = `${tempBase}.${extensionOf( source )}`;
    await copyFile( stripFilePrefix( source ), dest );
    return dest;
  } catch ( error ) {
    logger.info( "library_original_copy_failed", error );
    return null;
  }
};

// A temp copy of the photo's untouched original from the device library, for
// sharing in place of the iNaturalist copy. Only the original the app recorded
// at import, never one matched by time and location, which could be the wrong
// photo. Null when there's no original to be had.
export const copyLibraryOriginal = async (
  query: Query,
  tempBase: string,
): Promise<string | null> => (
  query.deviceUri
    ? copyDevicePhoto( query.deviceUri, tempBase )
    : null
);
