import Config from "react-native-config";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { zustandStorage } from "stores/useStore";

const ANIMAL_CROP_LOG_KEY = "animalCropLog";
const logger = log.extend( "animalCropLog" );

export type AnimalCropLog = Record<string, NormalizedCrop>;

interface CropLogEntry {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

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
  .map( ( [url, crop] ) => ( {
    url,
    x: crop.x,
    y: crop.y,
    w: crop.w,
    h: crop.h,
  } ) );

const _putToFirebase = ( entries: CropLogEntry[] ) => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  fetch( `${baseUrl}/crop_log.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify( entries ),
  } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase sync failed", r.status ); } )
    .catch( err => logger.warn( "Firebase sync error", err ) );
};

async function syncToFirebase( localLogArray: CropLogEntry[] ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  _putToFirebase( localLogArray );
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

export const getAnimalCrop = ( url: string ): NormalizedCrop | null => {
  const logObj = load( );
  return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
};
