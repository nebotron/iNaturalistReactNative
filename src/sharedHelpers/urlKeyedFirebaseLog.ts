import Config from "react-native-config";
import { logWithoutRemote } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

// Normalise photo URLs to the "large" size so an entry saved against one size
// (e.g. the large URL the crop tool stores) is found when looked up under
// another (e.g. the original-size URL the explore page uses), and vice-versa.
export const normalizePhotoUrl = ( url: string ): string => url.replace(
  /\/(square|small|medium|large|original)(\.(?:jpe?g|png|webp|gif))/i,
  "/large$2",
);

// Firebase keys can't contain . $ # [ ] / — encodeURIComponent escapes all of
// those except the dot, which we handle explicitly. The RTDB REST API also
// percent-decodes the path once, so a singly-encoded key decodes back into
// those forbidden tokens ("Invalid token in path", HTTP 400) — double-encode
// so the server's decode yields a literal, still-escaped key.
const fbKey = ( url: string ): string => encodeURIComponent(
  encodeURIComponent( url ).replace( /\./g, "%2E" ),
);

interface UrlKeyedFirebaseLogOptions<T> {
  // MMKV key for the local log and the label used by the local-only logger.
  storageKey: string;
  // Child path under CROP_LOG_FIREBASE_URL the offline tuning scripts read.
  firebasePath: string;
  // Store entries under the "large"-normalized URL rather than the raw key.
  normalizeKeyOnSave?: boolean;
  // Whether an entry for this (already key-resolved) URL is worth syncing.
  shouldSync: ( url: string ) => boolean;
  // Flattened shape written to Firebase for a value keyed by url.
  toFirebaseEntry: ( url: string, value: T ) => Record<string, unknown>;
}

export interface UrlKeyedFirebaseLog<T> {
  load: ( ) => Record<string, T>;
  save: ( photoUrl: string, value: T ) => Promise<void>;
  remove: ( photoUrl: string ) => void;
  get: ( url: string ) => T | null;
  subscribe: ( listener: ( ) => void ) => ( ) => void;
}

// Factory for a URL-keyed log that mirrors write-only to a Firebase RTDB path
// for offline CV-tuning scripts. The app never reads Firebase (reads require
// auth and the app carries no credentials); viewers show the local log.
export const createUrlKeyedFirebaseLog = <T>(
  options: UrlKeyedFirebaseLogOptions<T>,
): UrlKeyedFirebaseLog<T> => {
  const {
    storageKey, firebasePath, normalizeKeyOnSave = false, shouldSync, toFirebaseEntry,
  } = options;
  // Sync failures are about Firebase itself and spike when a build/DB
  // regresses; routing them through the remote logger POSTs an extra app_log
  // entry per failure — a feedback loop that floods the log. Keep them local.
  const logger = logWithoutRemote.extend( storageKey );
  const listeners = new Set<( ) => void>( );

  const load = ( ): Record<string, T> => {
    const raw = zustandStorage.getItem( storageKey );
    if ( !raw || typeof raw !== "string" ) return {};
    try {
      return JSON.parse( raw ) as Record<string, T>;
    } catch {
      return {};
    }
  };

  // Write a single entry to its own URL-keyed child. Keying by the photo URL
  // means re-saving a photo overwrites its entry instead of appending a
  // duplicate, and writing one child never downloads the (ever-growing) log to
  // merge — that read-before-write was the biggest source of Firebase download
  // traffic. The log DB allows unauthenticated writes, so no auth token here.
  const putToFirebase = async ( url: string, value: T ): Promise<void> => {
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl ) return;
    try {
      const r = await fetch( `${baseUrl}/${firebasePath}/${fbKey( url )}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify( toFirebaseEntry( url, value ) ),
      } );
      if ( !r.ok ) logger.warn( "Firebase sync failed", r.status );
    } catch ( err ) {
      logger.warn( "Firebase sync error", err );
    }
  };

  // URL-keyed storage lets us delete the single child directly — no download.
  const deleteFromFirebase = ( url: string ) => {
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl ) return;
    fetch( `${baseUrl}/${firebasePath}/${fbKey( url )}.json`, { method: "DELETE" } )
      .then( r => { if ( !r.ok ) logger.warn( "Firebase delete failed", r.status ); } )
      .catch( err => logger.warn( "Firebase delete error", err ) );
  };

  const save = ( photoUrl: string, value: T ): Promise<void> => {
    const key = normalizeKeyOnSave
      ? normalizePhotoUrl( photoUrl )
      : photoUrl;
    const current = load( );
    current[key] = value;
    zustandStorage.setItem( storageKey, JSON.stringify( current ) );
    listeners.forEach( l => l( ) );
    // Only sync entries whose value was actually written to Firebase, so we
    // never issue a request for a key that was skipped on save.
    if ( !shouldSync( key ) ) return Promise.resolve( );
    return putToFirebase( key, value );
  };

  const remove = ( photoUrl: string ) => {
    const key = normalizeKeyOnSave
      ? normalizePhotoUrl( photoUrl )
      : photoUrl;
    const current = load( );
    delete current[key];
    zustandStorage.setItem( storageKey, JSON.stringify( current ) );
    listeners.forEach( l => l( ) );
    if ( !shouldSync( key ) ) return;
    deleteFromFirebase( key );
  };

  const get = ( url: string ): T | null => {
    const logObj = load( );
    return logObj[url] ?? logObj[normalizePhotoUrl( url )] ?? null;
  };

  const subscribe = ( listener: ( ) => void ): ( ) => void => {
    listeners.add( listener );
    return ( ) => listeners.delete( listener );
  };

  return {
    load, save, remove, get, subscribe,
  };
};
