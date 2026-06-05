import Clipboard from "@react-native-clipboard/clipboard";
import Config from "react-native-config";
import { Alert } from "react-native";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { zustandStorage } from "stores/useStore";

const ANIMAL_CROP_LOG_KEY = "animalCropLog";
const logger = log.extend( "animalCropLog" );

export type AnimalCropLog = Record<string, NormalizedCrop>;

const load = ( ): AnimalCropLog => {
  const raw = zustandStorage.getItem( ANIMAL_CROP_LOG_KEY );
  if ( !raw || typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as AnimalCropLog;
  } catch {
    return {};
  }
};

const _logToArray = ( logObj: AnimalCropLog ) =>
  Object.entries( logObj )
    .filter( ( [url] ) => url.startsWith( "http" ) )
    .map( ( [url, crop] ) => ( {
      url,
      x: crop.x,
      y: crop.y,
      w: crop.w,
      h: crop.h,
    } ) );

/**
 * Push the full log to a GitHub Gist so it is accessible without needing
 * a local dev-server connection.
 *
 * Requires in .env:
 *   CROP_LOG_GIST_ID=<gist id>
 *   CROP_LOG_GITHUB_TOKEN=<personal access token with gist scope>
 */
function syncToGist( logArray: ReturnType<typeof _logToArray> ) {
  const gistId = Config.CROP_LOG_GIST_ID;
  const token = Config.CROP_LOG_GITHUB_TOKEN;
  if ( !gistId || !token ) return;

  fetch( `https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "iNaturalistReactNative",
    },
    body: JSON.stringify( {
      files: {
        "crop_training.json": {
          content: JSON.stringify( logArray, null, 2 ),
        },
      },
    } ),
  } )
    .then( r => { if ( !r.ok ) logger.warn( "Gist sync failed", r.status ); } )
    .catch( err => logger.warn( "Gist sync error", err ) );
}

export const saveAnimalCrop = ( photoUrl: string, crop: NormalizedCrop ) => {
  const current = load( );
  current[photoUrl] = crop;
  zustandStorage.setItem( ANIMAL_CROP_LOG_KEY, JSON.stringify( current ) );
  syncToGist( _logToArray( current ) );
};

export const getAnimalCropCount = ( ): number => Object.keys( load( ) ).length;

export const getAnimalCropLogAsArray = ( ) => _logToArray( load( ) );

export const copyAnimalCropLogToClipboard = ( ) => {
  const current = load( );
  const count = Object.keys( current ).length;
  Clipboard.setString( JSON.stringify( current, null, 2 ) );
  Alert.alert( "Copied", `${count} crops copied to clipboard.` );
};
