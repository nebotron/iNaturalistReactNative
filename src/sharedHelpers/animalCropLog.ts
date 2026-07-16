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
    // Handle object formats: url-keyed { "<key>": { url, x, y, w, h } } (the
    // value carries the url), and legacy { "<url>": { x, y, w, h } }.
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
    // null/absent node = genuinely empty log
    return [];
  } catch ( err ) {
    logger.warn( "Firebase fetch error", err );
    return null;
  }
};

// Firebase keys can't contain . $ # [ ] / — encodeURIComponent escapes all of
// those except the dot, which we handle explicitly.
const fbKey = ( url: string ): string => encodeURIComponent( url ).replace( /\./g, "%2E" );

// Write a single entry to its own URL-keyed child. Keying by the photo URL
// means re-saving a photo overwrites its entry instead of appending a
// duplicate, and writing one child never downloads the (ever-growing) log to
// merge — that read-before-write was the biggest source of Firebase download
// traffic — while other entries are left untouched. The log DB allows
// unauthenticated writes, so no auth token is needed here.
const putToFirebase = ( entry: CropLogEntry ) => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  fetch( `${baseUrl}/crop_log/${fbKey( entry.url )}.json`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify( entry ),
  } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase sync failed", r.status ); } )
    .catch( err => logger.warn( "Firebase sync error", err ) );
};

// URL-keyed storage lets us delete the single child directly — no download.
const deleteFromFirebase = ( photoUrl: string ) => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  fetch( `${baseUrl}/crop_log/${fbKey( photoUrl )}.json`, { method: "DELETE" } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase delete failed", r.status ); } )
    .catch( err => logger.warn( "Firebase delete error", err ) );
};

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
  putToFirebase( {
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
