import Clipboard from "@react-native-clipboard/clipboard";
import { Alert } from "react-native";
import Config from "react-native-config";
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

const _logToArray = ( logObj: AnimalCropLog ) => Object.entries( logObj )
  .filter( ( [url] ) => url.startsWith( "http" ) )
  .map( ( [url, crop] ) => ( {
    url,
    x: crop.x,
    y: crop.y,
    w: crop.w,
    h: crop.h,
  } ) );

/**
 * Push the full log to Firebase Realtime Database (public read/write rules,
 * no credentials needed in the app).
 *
 * Requires in .env:
 *   CROP_LOG_FIREBASE_URL=https://<project-id>.firebaseio.com
 */
function syncToFirebase( logArray: ReturnType<typeof _logToArray> ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;

  fetch( `${baseUrl}/crop_log.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify( logArray ),
  } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase sync failed", r.status ); } )
    .catch( err => logger.warn( "Firebase sync error", err ) );
}

// Normalise photo URLs to the "large" size so crops saved from the crop
// tool (which stores large URLs) are found when the explore page looks up
// original-size URLs (and vice-versa).
const normalizePhotoUrl = ( url: string ): string => url.replace(
  /\/(square|small|medium|large|original)(\.(?:jpe?g|png|webp|gif))/i,
  "/large$2",
);

export const saveAnimalCrop = ( photoUrl: string, crop: NormalizedCrop ) => {
  const current = load( );
  current[photoUrl] = crop;
  zustandStorage.setItem( ANIMAL_CROP_LOG_KEY, JSON.stringify( current ) );
  syncToFirebase( _logToArray( current ) );
};

export const deleteAnimalCrop = ( photoUrl: string ) => {
  const current = load( );
  delete current[photoUrl];
  zustandStorage.setItem( ANIMAL_CROP_LOG_KEY, JSON.stringify( current ) );
  syncToFirebase( _logToArray( current ) );
};

export const getAnimalCrop = ( url: string ): NormalizedCrop | null => {
  const logObj = load( );
  return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
};

export const getAnimalCropCount = ( ): number => Object.keys( load( ) ).length;

export const getAnimalCropLogAsArray = ( ) => _logToArray( load( ) );

export const copyAnimalCropLogToClipboard = ( ) => {
  const current = load( );
  const count = Object.keys( current ).length;
  Clipboard.setString( JSON.stringify( current, null, 2 ) );
  Alert.alert( "Copied", `${count} crops copied to clipboard.` );
};
