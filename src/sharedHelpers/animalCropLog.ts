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

/**
 * Requires in .env:
 *   CROP_LOG_FIREBASE_URL=https://<project-id>.firebaseio.com
 */
export const fetchCropLogFromFirebase = async ( ): Promise<CropLogEntry[]> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return [];
  try {
    const res = await fetch( `${baseUrl}/crop_log.json` );
    if ( !res.ok ) return [];
    const data = await res.json( );
    if ( Array.isArray( data ) ) {
      return data.filter( Boolean );
    }
    // Handle object formats: push-keyed { "<id>": { url, x, y, w, h } } from
    // the appended log, and legacy { "<url>": { x, y, w, h } }.
    if ( data && typeof data === "object" ) {
      return ( Object.entries( data ) as [string, Partial<CropLogEntry> & NormalizedCrop][] )
        .map( ( [key, crop] ) => ( {
          url: typeof crop.url === "string" ? crop.url : key,
          x: crop.x,
          y: crop.y,
          w: crop.w,
          h: crop.h,
        } ) )
        .filter( entry => entry.url.startsWith( "http" ) );
    }
    return [];
  } catch ( err ) {
    logger.warn( "Firebase fetch error", err );
    return [];
  }
};

// Append a single entry via POST. Firebase generates a unique child key, so we
// never download the (ever-growing) log to merge before writing. That
// read-before-write was the single biggest source of Firebase download
// traffic, and appending still preserves entries from other devices/installs
// instead of clobbering them with a whole-log overwrite.
const appendToFirebase = ( entry: CropLogEntry ) => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  fetch( `${baseUrl}/crop_log.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify( entry ),
  } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase sync failed", r.status ); } )
    .catch( err => logger.warn( "Firebase sync error", err ) );
};

// Deletes are rare (dev-only), so here we do read the log once to find the
// child keys matching this URL, then remove just those children.
async function deleteFromFirebase( photoUrl: string ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  try {
    const res = await fetch( `${baseUrl}/crop_log.json` );
    if ( !res.ok ) return;
    const data = await res.json( );
    if ( !data || typeof data !== "object" ) return;
    await Promise.all(
      ( Object.entries( data ) as [string, CropLogEntry][] )
        .filter( ( [, entry] ) => entry?.url === photoUrl )
        .map( ( [key] ) => fetch( `${baseUrl}/crop_log/${key}.json`, { method: "DELETE" } ) ),
    );
  } catch ( err ) {
    logger.warn( "Firebase delete error", err );
  }
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
  appendToFirebase( {
    url: photoUrl, x: crop.x, y: crop.y, w: crop.w, h: crop.h,
  } );
};

export const deleteAnimalCrop = ( photoUrl: string ) => {
  const current = load( );
  delete current[photoUrl];
  zustandStorage.setItem( ANIMAL_CROP_LOG_KEY, JSON.stringify( current ) );
  deleteFromFirebase( photoUrl );
};

export const getAnimalCrop = ( url: string ): NormalizedCrop | null => {
  const logObj = load( );
  return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
};
