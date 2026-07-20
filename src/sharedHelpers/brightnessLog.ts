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

// The app never reads the Firebase log (reads require auth and the app
// carries no credentials — sync is write-only). Labeled brightness values
// land at {CROP_LOG_FIREBASE_URL}/brightness_log for the offline tuning
// scripts, which authenticate from .env.

// Firebase keys can't contain . $ # [ ] / — encodeURIComponent escapes all of
// those except the dot, which we handle explicitly. The RTDB REST API also
// percent-decodes the path once, so a singly-encoded key decodes back into
// those forbidden tokens ("Invalid token in path", HTTP 400) — double-encode
// so the server's decode yields a literal, still-escaped key.
const fbKey = ( url: string ): string => encodeURIComponent(
  encodeURIComponent( url ).replace( /\./g, "%2E" ),
);

// Write a single entry to its own URL-keyed child. Keying by the photo URL
// means re-saving a photo overwrites its entry instead of appending a
// duplicate, and writing one child never downloads the log to merge — that
// read-before-write was the biggest source of Firebase download traffic. The
// log DB allows unauthenticated writes, so no auth token is needed here.
const putToFirebase = async ( entry: BrightnessLogEntry ): Promise<void> => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  try {
    const r = await fetch( `${baseUrl}/brightness_log/${fbKey( entry.url )}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( entry ),
    } );
    if ( !r.ok ) logger.warn( "Firebase sync failed", r.status );
  } catch ( err ) {
    logger.warn( "Firebase sync error", err );
  }
};

// URL-keyed storage lets us delete the single child directly — no download.
const deleteFromFirebase = ( photoUrl: string ) => {
  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;
  fetch( `${baseUrl}/brightness_log/${fbKey( photoUrl )}.json`, { method: "DELETE" } )
    .then( r => { if ( !r.ok ) logger.warn( "Firebase delete failed", r.status ); } )
    .catch( err => logger.warn( "Firebase delete error", err ) );
};

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
  return putToFirebase( { url, brightness } );
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
