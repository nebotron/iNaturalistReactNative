import Config from "react-native-config";
import firebaseAuthQuery from "sharedHelpers/firebaseRtdbAuth";
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

/**
 * Requires in .env:
 *   CROP_LOG_FIREBASE_URL=https://<project-id>.firebaseio.com
 */
// Returns null when the fetch fails (offline, permission denied, …) so that
// sync callers can abort instead of treating failure as "remote is empty"
// and overwriting the remote log with only this device's crops.
export const fetchCropLogFromFirebase = async ( ): Promise<CropLogEntry[] | null> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return null;
  try {
    const auth = await firebaseAuthQuery( );
    const res = await fetch( `${baseUrl}/crop_log.json${auth}` );
    if ( !res.ok ) {
      logger.warn( "Firebase fetch failed", res.status );
      return null;
    }
    const data = await res.json( );
    if ( Array.isArray( data ) ) {
      return data.filter( Boolean );
    }
    // Handle legacy object format: { "url": { x, y, w, h } }
    if ( data && typeof data === "object" ) {
      return ( Object.entries( data ) as [string, NormalizedCrop][] )
        .filter( ( [url] ) => url.startsWith( "http" ) )
        .map( ( [url, crop] ) => ( {
          url,
          x: crop.x,
          y: crop.y,
          w: crop.w,
          h: crop.h,
        } ) );
    }
    // null/absent node = genuinely empty log
    return [];
  } catch ( err ) {
    logger.warn( "Firebase fetch error", err );
    return null;
  }
};

const _mergeByUrl = ( a: CropLogEntry[], b: CropLogEntry[] ): CropLogEntry[] => {
  const byUrl = new Map<string, CropLogEntry>( );
  [...a, ...b].forEach( entry => byUrl.set( entry.url, entry ) );
  return Array.from( byUrl.values( ) );
};

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

// Merges with whatever is already on Firebase so entries synced from other
// devices/installs aren't clobbered by an overwrite based on incomplete
// local data.
async function syncToFirebase( localLogArray: CropLogEntry[] ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  const remote = await fetchCropLogFromFirebase( );
  if ( remote === null ) return; // can't read remote — don't clobber it
  _putToFirebase( _mergeByUrl( remote, localLogArray ) );
}

async function deleteFromFirebase( photoUrl: string, localLogArray: CropLogEntry[] ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  const remote = await fetchCropLogFromFirebase( );
  if ( remote === null ) return; // can't read remote — don't clobber it
  const merged = _mergeByUrl( remote, localLogArray ).filter( e => e.url !== photoUrl );
  _putToFirebase( merged );
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
  deleteFromFirebase( photoUrl, _logToArray( current ) );
};

export const getAnimalCrop = ( url: string ): NormalizedCrop | null => {
  const logObj = load( );
  return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
};
