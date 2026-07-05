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
    if ( data && typeof data === "object" ) {
      return ( Object.entries( data ) as [string, number][] )
        .filter( ( [url] ) => url.startsWith( "http" ) )
        .map( ( [url, brightness] ) => ( { url, brightness } ) );
    }
    return [];
  } catch ( err ) {
    logger.warn( "Firebase fetch error", err );
    return [];
  }
};

const _mergeByUrl = (
  a: BrightnessLogEntry[],
  b: BrightnessLogEntry[],
): BrightnessLogEntry[] => {
  const byUrl = new Map<string, BrightnessLogEntry>( );
  [...a, ...b].forEach( entry => byUrl.set( entry.url, entry ) );
  return Array.from( byUrl.values( ) );
};

const _putToFirebase = async ( entries: BrightnessLogEntry[] ): Promise<void> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  try {
    const r = await fetch( `${baseUrl}/brightness_log.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( entries ),
    } );
    if ( !r.ok ) logger.warn( "Firebase sync failed", r.status );
  } catch ( err ) {
    logger.warn( "Firebase sync error", err );
  }
};

async function syncToFirebase( localArray: BrightnessLogEntry[] ): Promise<void> {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  const remote = await fetchBrightnessLogFromFirebase( );
  await _putToFirebase( _mergeByUrl( remote, localArray ) );
}

async function deleteFromFirebase( photoUrl: string, localArray: BrightnessLogEntry[] ) {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  const remote = await fetchBrightnessLogFromFirebase( );
  const merged = _mergeByUrl( remote, localArray ).filter( e => e.url !== photoUrl );
  _putToFirebase( merged );
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
  const current = load( );
  current[normalizePhotoUrl( photoUrl )] = brightness;
  zustandStorage.setItem( BRIGHTNESS_LOG_KEY, JSON.stringify( current ) );
  _brightnessLogListeners.forEach( l => l( ) );
  return syncToFirebase( _logToArray( current ) );
};

export const deleteBrightness = ( photoUrl: string ) => {
  const current = load( );
  delete current[normalizePhotoUrl( photoUrl )];
  zustandStorage.setItem( BRIGHTNESS_LOG_KEY, JSON.stringify( current ) );
  deleteFromFirebase( normalizePhotoUrl( photoUrl ), _logToArray( current ) );
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
