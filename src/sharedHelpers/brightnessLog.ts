import Clipboard from "@react-native-clipboard/clipboard";
import { Alert } from "react-native";
import Config from "react-native-config";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

const BRIGHTNESS_LOG_KEY = "brightnessLog";
const logger = log.extend( "brightnessLog" );

export type BrightnessLog = Record<string, number>;

export interface BrightnessLogEntry {
  url: string;
  brightness: number; // ideal brightness multiplier (1.0 = no change)
}

const load = ( ): BrightnessLog => {
  const raw = zustandStorage.getItem( BRIGHTNESS_LOG_KEY );
  if ( !raw || typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as BrightnessLog;
  } catch {
    return {};
  }
};

const _logToArray = ( logObj: BrightnessLog ): BrightnessLogEntry[] => Object.entries( logObj )
  .filter( ( [url] ) => url.startsWith( "http" ) && !url.includes( "static.inaturalist.org" ) )
  .map( ( [url, brightness] ) => ( { url, brightness } ) );

/**
 * Requires in .env:
 *   CROP_LOG_FIREBASE_URL=https://<project-id>.firebaseio.com
 *
 * Labeled brightness values are stored at {baseUrl}/brightness_log.json
 * alongside the crop log, for use in offline brightness tuning scripts.
 */
export const fetchBrightnessLogFromFirebase = async ( ): Promise<BrightnessLogEntry[]> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return [];
  try {
    const res = await fetch( `${baseUrl}/brightness_log.json` );
    if ( !res.ok ) return [];
    const data = await res.json( );
    if ( Array.isArray( data ) ) return data.filter( Boolean );
    // Handle push-keyed { "<id>": { url, brightness } } from the appended log,
    // and legacy { "<url>": brightness }.
    if ( data && typeof data === "object" ) {
      return ( Object.entries( data ) as [string, BrightnessLogEntry | number][] )
        .map( ( [key, val] ) => ( val && typeof val === "object"
          ? { url: val.url, brightness: val.brightness }
          : { url: key, brightness: val as number } ) )
        .filter( entry => typeof entry.url === "string" && entry.url.startsWith( "http" ) );
    }
    return [];
  } catch ( err ) {
    logger.warn( "Firebase fetch error", err );
    return [];
  }
};

// Append a single entry via POST. Firebase generates a unique child key, so we
// never download the (ever-growing) log to merge before writing — that
// read-before-write was the single biggest source of Firebase download
// traffic — while still preserving entries from other devices/installs.
const appendToFirebase = async ( entry: BrightnessLogEntry ): Promise<void> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  try {
    const r = await fetch( `${baseUrl}/brightness_log.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( entry ),
    } );
    if ( !r.ok ) logger.warn( "Firebase sync failed", r.status );
  } catch ( err ) {
    logger.warn( "Firebase sync error", err );
  }
};

// Deletes are rare (dev-only), so here we do read the log once to find the
// child keys matching this URL, then remove just those children.
async function deleteFromFirebase( photoUrl: string ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  try {
    const res = await fetch( `${baseUrl}/brightness_log.json` );
    if ( !res.ok ) return;
    const data = await res.json( );
    if ( !data || typeof data !== "object" ) return;
    await Promise.all(
      ( Object.entries( data ) as [string, BrightnessLogEntry][] )
        .filter( ( [, entry] ) => entry?.url === photoUrl )
        .map( ( [key] ) => fetch( `${baseUrl}/brightness_log/${key}.json`, { method: "DELETE" } ) ),
    );
  } catch ( err ) {
    logger.warn( "Firebase delete error", err );
  }
}

const normalizePhotoUrl = ( url: string ): string => url.replace(
  /\/(square|small|medium|large|original)(\.(?:jpe?g|png|webp|gif))/i,
  "/large$2",
);

const _brightnessLogListeners = new Set<( ) => void>( );

export const subscribeToBrightnessLog = ( listener: ( ) => void ): ( ) => void => {
  _brightnessLogListeners.add( listener );
  return ( ) => _brightnessLogListeners.delete( listener );
};

export const saveBrightness = ( photoUrl: string, brightness: number ): Promise<void> => {
  const url = normalizePhotoUrl( photoUrl );
  const current = load( );
  current[url] = brightness;
  zustandStorage.setItem( BRIGHTNESS_LOG_KEY, JSON.stringify( current ) );
  _brightnessLogListeners.forEach( l => l( ) );
  if ( !url.startsWith( "http" ) || url.includes( "static.inaturalist.org" ) ) {
    return Promise.resolve( );
  }
  return appendToFirebase( { url, brightness } );
};

export const deleteBrightness = ( photoUrl: string ) => {
  const current = load( );
  delete current[normalizePhotoUrl( photoUrl )];
  zustandStorage.setItem( BRIGHTNESS_LOG_KEY, JSON.stringify( current ) );
  deleteFromFirebase( normalizePhotoUrl( photoUrl ) );
};

export const getBrightness = ( url: string ): number | null => {
  const logObj = load( );
  return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
};

export const getBrightnessLogCount = ( ): number => Object.keys( load( ) ).length;

export const getBrightnessLogAsArray = ( ) => _logToArray( load( ) ).reverse( );

export const copyBrightnessLogToClipboard = ( ) => {
  const current = load( );
  const count = Object.keys( current ).length;
  Clipboard.setString( JSON.stringify( current, null, 2 ) );
  Alert.alert( "Copied", `${count} brightness labels copied to clipboard.` );
};
