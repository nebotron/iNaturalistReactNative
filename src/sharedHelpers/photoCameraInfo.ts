import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import exifUri from "sharedHelpers/exifUri";
import { readFocusDistanceFromFile } from "sharedHelpers/focusDistance";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "photoCameraInfo" );

export interface PhotoCameraInfo {
  camera?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
  shutterSpeed?: string;
  iso?: string;
  focusDistance?: string;
  // Every other tag, by name, for the full table.
  metadata?: [string, string][];
}

// Tags already shown, formatted, in the fields above.
const FORMATTED_TAGS = new Set( [
  "Make", "Model", "LensModel", "FocalLength", "FocalLenIn35mmFilm", "FNumber",
  "ExposureTime", "ISOSpeedRatings", "SubjectDistance",
] );

const round = ( value: number, places = 1 ) => String(
  Math.round( value * ( 10 ** places ) ) / ( 10 ** places ),
);

const exposure = ( seconds: number ) => ( seconds >= 1
  ? `${round( seconds )} s`
  : `1/${Math.round( 1 / seconds )} s` );

const formatValue = ( value: unknown ): string => {
  if ( typeof value === "number" ) return round( value, 4 );
  if ( Array.isArray( value ) ) return value.map( formatValue ).join( ", " );
  if ( value && typeof value === "object" ) return JSON.stringify( value );
  return String( value ?? "" ).trim( );
};

const positive = ( value: unknown ): number | null => {
  const number = Number( value );
  return Number.isFinite( number ) && number > 0
    ? number
    : null;
};

// Camera, lens, exposure, focus distance and every other tag ImageIO reads out of a photo
// (Make/Model from the TIFF dictionary, the rest from the Exif one).
export const formatCameraInfo = ( tags?: ExifTags | null ): PhotoCameraInfo | null => {
  if ( !tags ) return null;
  const make = typeof tags.Make === "string"
    ? tags.Make.trim( )
    : "";
  const model = typeof tags.Model === "string"
    ? tags.Model.trim( )
    : "";
  const camera = model && make && !model.toLowerCase( ).startsWith( make.toLowerCase( ) )
    ? `${make} ${model}`
    : model || make;
  const lens = typeof tags.LensModel === "string"
    ? tags.LensModel.trim( )
    : "";

  const focal = positive( tags.FocalLength );
  const equivalent = positive( tags.FocalLenIn35mmFilm );
  const fNumber = positive( tags.FNumber );
  const time = positive( tags.ExposureTime );
  const iso = positive( Array.isArray( tags.ISOSpeedRatings )
    ? tags.ISOSpeedRatings[0]
    : tags.ISOSpeedRatings );
  // Copied in from Canon's MakerNote by copyFocusDistance.
  const distance = positive( tags.SubjectDistance );

  const info: PhotoCameraInfo = {
    camera: camera || undefined,
    lens: lens || undefined,
    focalLength: focal
      ? `${round( focal )} mm${equivalent && Math.round( equivalent ) !== Math.round( focal )
        ? ` (${Math.round( equivalent )} mm equiv.)`
        : ""}`
      : undefined,
    aperture: fNumber
      ? `f/${round( fNumber )}`
      : undefined,
    shutterSpeed: time
      ? exposure( time )
      : undefined,
    iso: iso
      ? String( iso )
      : undefined,
    focusDistance: distance
      ? `${round( distance, 2 )} m`
      : undefined,
  };
  if ( !Object.values( info ).some( Boolean ) ) return null;
  const metadata = Object.keys( tags ).sort( )
    .filter( tag => !FORMATTED_TAGS.has( tag ) )
    .map( ( tag ): [string, string] => [tag, formatValue( tags[tag] )] )
    .filter( ( [, value] ) => value );
  return metadata.length > 0
    ? { ...info, metadata }
    : info;
};

// Canon keeps the focus distance in its MakerNote, which Exify doesn't read,
// so read it from the file: the local copy when copyFocusDistance couldn't
// (photos imported from ph:// uris), or the library original behind one.
const readCanonFocusDistance = async ( uri: string, model: string ): Promise<number | null> => {
  let source = uri.startsWith( "ph://" )
    ? "ph"
    : "file";
  let reason = "";
  try {
    const path = uri.startsWith( "ph://" )
      ? ( await CameraRoll.iosGetImageDataById( uri.slice( "ph://".length ) ) )
        .node.image.filepath
      : uri;
    // The scheme and extension only: a path names the user's file.
    source += `:${path?.split( "?" )[0].split( "." ).pop( )?.toLowerCase( ) ?? "none"}`;
    const distance = path
      ? await readFocusDistanceFromFile( path, miss => { reason = miss; } )
      : null;
    if ( distance === null ) {
      logger.info( `photo_focus_distance_missing: ${model} ${source} ${reason || "no_path"}` );
    }
    return distance;
  } catch ( error ) {
    logger.warn( `photo_focus_distance_unreadable: ${model} ${source}`, error );
    return null;
  }
};

const cache = new Map<string, PhotoCameraInfo | null>( );

export const readCameraInfo = async ( uri: string ): Promise<PhotoCameraInfo | null> => {
  if ( cache.has( uri ) ) return cache.get( uri ) ?? null;
  let tags: ExifTags | null = null;
  try {
    tags = await Exify.read( exifUri( uri ) );
  } catch ( error ) {
    logger.warn( "photo_camera_info_unreadable", error );
    // A deleted library original stays deleted; don't read and warn again.
    cache.set( uri, null );
    return null;
  }
  if ( tags && !tags.SubjectDistance ) {
    const model = `${tags.Make ?? ""} ${tags.Model ?? ""}`.trim( );
    if ( /canon/i.test( model ) ) {
      const distance = await readCanonFocusDistance( uri, model );
      if ( distance ) tags = { ...tags, SubjectDistance: distance };
    } else {
      logger.info( `photo_focus_distance_missing: ${model || "unknown"} not_canon` );
    }
  }
  const info = formatCameraInfo( tags );
  if ( !info ) {
    // Tag names only, so a photo that shows nothing says what it did carry.
    logger.info( `photo_camera_info_empty: ${Object.keys( tags ?? {} ).sort( ).join( "," )}` );
  }
  cache.set( uri, info );
  return info;
};
