import Config from "react-native-config";
import { MMKV } from "react-native-mmkv";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

// Firebase is the record; the device keeps an entry only long enough to show
// the user their own framing again when they come back to a photo.
const LOCAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// A local entry: the value, when it was saved, and whether Firebase has it
interface LocalEntry<T> { v: T; t: number; synced?: boolean }

// Normalise photo URLs to the "large" size so an entry saved against one size
// (e.g. the large URL the crop tool stores) is found when looked up under
// another (e.g. the original-size URL the explore page uses), and vice-versa.
const normalizePhotoUrl = ( url: string ): string => url.replace(
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
  // Retries entries Firebase never got, and drops synced ones past LOCAL_TTL_MS
  maintain: ( ) => Promise<void>;
}

// Factory for a URL-keyed log that mirrors write-only to a Firebase RTDB path
// for offline CV-tuning scripts. The app never reads Firebase — viewers show
// the local log instead, since the local copy is what the app itself acted on.
// Locally it's an MMKV instance of its own with one key per URL, so a save
// writes one entry and a lookup reads one, rather than the whole log.
export const createUrlKeyedFirebaseLog = <T>(
  options: UrlKeyedFirebaseLogOptions<T>,
): UrlKeyedFirebaseLog<T> => {
  const {
    storageKey, firebasePath, normalizeKeyOnSave = false, shouldSync, toFirebaseEntry,
  } = options;
  const listeners = new Set<( ) => void>( );
  const store = new MMKV( { id: storageKey } );

  const read = ( key: string ): LocalEntry<T> | null => {
    const json = store.getString( key );
    if ( !json ) return null;
    try {
      return JSON.parse( json ) as LocalEntry<T>;
    } catch {
      return null;
    }
  };
  const write = ( key: string, entry: LocalEntry<T> ) => store.set( key, JSON.stringify( entry ) );

  // Until the local log had its own instance it was one JSON blob in the
  // default one, rewritten in full on every save. It went up to Firebase as it
  // was saved, so count it as synced and let it age out from now.
  const legacy = zustandMMKVBackingStorage.getString( storageKey );
  if ( legacy ) {
    try {
      const now = Date.now( );
      Object.entries( JSON.parse( legacy ) as Record<string, T> )
        .forEach( ( [key, v] ) => write( key, { v, t: now, synced: true } ) );
    } catch {
      // Unreadable; nothing to keep
    }
    zustandMMKVBackingStorage.delete( storageKey );
  }

  // Oldest first
  const entries = ( ) => store.getAllKeys( )
    .map( key => [key, read( key )] as const )
    .filter( ( e ): e is readonly [string, LocalEntry<T>] => !!e[1] )
    .sort( ( a, b ) => a[1].t - b[1].t );

  const load = ( ): Record<string, T> => Object.fromEntries(
    entries( ).map( ( [key, entry] ) => [key, entry.v] ),
  );

  // Write a single entry to its own URL-keyed child. Keying by the photo URL
  // means re-saving a photo overwrites its entry instead of appending a
  // duplicate, and writing one child never downloads the (ever-growing) log to
  // merge — that read-before-write was the biggest source of Firebase download
  // traffic. The log DB allows unauthenticated writes, so no auth token here.
  // Marks the entry synced once Firebase has it; one that fails is retried by
  // maintain( ) on a later launch.
  const putToFirebase = async ( url: string, entry: LocalEntry<T> ): Promise<void> => {
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl ) return;
    try {
      const response = await fetch( `${baseUrl}/${firebasePath}/${fbKey( url )}.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify( toFirebaseEntry( url, entry.v ) ),
      } );
      // Only if it wasn't changed or removed meanwhile
      if ( response.ok && read( url )?.t === entry.t ) write( url, { ...entry, synced: true } );
    } catch {
      // Sync failures are about Firebase itself; maintain( ) retries.
    }
  };

  // URL-keyed storage lets us delete the single child directly — no download.
  const deleteFromFirebase = ( url: string ) => {
    const baseUrl = Config.CROP_LOG_FIREBASE_URL;
    if ( !baseUrl ) return;
    fetch( `${baseUrl}/${firebasePath}/${fbKey( url )}.json`, { method: "DELETE" } )
      .catch( ( ) => {
        // Best-effort delete; a failure just leaves a stale child behind.
      } );
  };

  const save = ( photoUrl: string, value: T ): Promise<void> => {
    const key = normalizeKeyOnSave
      ? normalizePhotoUrl( photoUrl )
      : photoUrl;
    const entry = { v: value, t: Date.now( ) };
    write( key, entry );
    listeners.forEach( l => l( ) );
    // Only sync entries whose value was actually written to Firebase, so we
    // never issue a request for a key that was skipped on save.
    if ( !shouldSync( key ) ) return Promise.resolve( );
    return putToFirebase( key, entry );
  };

  const remove = ( photoUrl: string ) => {
    const key = normalizeKeyOnSave
      ? normalizePhotoUrl( photoUrl )
      : photoUrl;
    store.delete( key );
    listeners.forEach( l => l( ) );
    if ( !shouldSync( key ) ) return;
    deleteFromFirebase( key );
  };

  const get = ( url: string ): T | null => (
    read( url ) ?? read( normalizePhotoUrl( url ) )
  )?.v ?? null;

  const maintain = async ( ) => {
    const cutoff = Date.now( ) - LOCAL_TTL_MS;
    const pending: Promise<void>[] = [];
    entries( ).forEach( ( [key, entry] ) => {
      // Local paths never sync and are long gone by now
      if ( !shouldSync( key ) || entry.synced ) {
        if ( entry.t < cutoff ) store.delete( key );
      } else {
        pending.push( putToFirebase( key, entry ) );
      }
    } );
    await Promise.all( pending );
  };

  const subscribe = ( listener: ( ) => void ): ( ) => void => {
    listeners.add( listener );
    return ( ) => listeners.delete( listener );
  };

  return {
    load, save, remove, get, subscribe, maintain,
  };
};
