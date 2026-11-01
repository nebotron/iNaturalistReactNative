import type { ExifTags } from "@lodev09/react-native-exify";
import * as Exify from "@lodev09/react-native-exify";
import exifUri from "sharedHelpers/exifUri";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "photoCameraInfo" );

export interface PhotoCameraInfo {
  camera?: string;
  lens?: string;
  settings?: string;
}

const round = ( value: number, places = 1 ) => String(
  Math.round( value * ( 10 ** places ) ) / ( 10 ** places ),
);

const exposure = ( seconds: number ) => ( seconds >= 1
  ? `${round( seconds )} s`
  : `1/${Math.round( 1 / seconds )} s` );

const positive = ( value: unknown ): number | null => {
  const number = Number( value );
  return Number.isFinite( number ) && number > 0
    ? number
    : null;
};

// Camera, lens and exposure from the tags ImageIO reads out of a photo
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

  const settings: string[] = [];
  const focal = positive( tags.FocalLength );
  if ( focal ) {
    const equivalent = positive( tags.FocalLenIn35mmFilm );
    settings.push( equivalent && Math.round( equivalent ) !== Math.round( focal )
      ? `${round( focal )} mm (${Math.round( equivalent )} mm equiv.)`
      : `${round( focal )} mm` );
  }
  const fNumber = positive( tags.FNumber );
  if ( fNumber ) settings.push( `f/${round( fNumber )}` );
  const time = positive( tags.ExposureTime );
  if ( time ) settings.push( exposure( time ) );
  const iso = positive( Array.isArray( tags.ISOSpeedRatings )
    ? tags.ISOSpeedRatings[0]
    : tags.ISOSpeedRatings );
  if ( iso ) settings.push( `ISO ${iso}` );
  const distance = positive( tags.SubjectDistance );
  if ( distance ) settings.push( `${round( distance, 2 )} m away` );

  if ( !camera && !lens && settings.length === 0 ) return null;
  return {
    camera: camera || undefined,
    lens: lens || undefined,
    settings: settings.join( " · " ) || undefined,
  };
};

const cache = new Map<string, PhotoCameraInfo | null>( );

export const readCameraInfo = async ( uri: string ): Promise<PhotoCameraInfo | null> => {
  if ( cache.has( uri ) ) return cache.get( uri ) ?? null;
  let tags: ExifTags | null = null;
  try {
    tags = await Exify.read( exifUri( uri ) );
  } catch ( error ) {
    logger.warn( "photo_camera_info_unreadable", error );
    return null;
  }
  const info = formatCameraInfo( tags );
  if ( !info ) {
    // Tag names only, so a photo that shows nothing says what it did carry.
    logger.info( `photo_camera_info_empty: ${Object.keys( tags ?? {} ).sort( ).join( "," )}` );
  }
  cache.set( uri, info );
  return info;
};
