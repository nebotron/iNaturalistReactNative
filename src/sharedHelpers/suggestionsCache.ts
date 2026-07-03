import { MMKV } from "react-native-mmkv";

// Persists CV suggestion results (online and offline) to disk so they
// survive app restarts. Scoring a photo is expensive (network round-trip for
// the online model, on-device inference for the offline model), and results
// for a given photo + location never change, so there's no reason to redo
// that work just because the app was relaunched.
const CACHE_MMKV_ID = "cv-suggestions-cache";
const KEY_INDEX_KEY = "__keyIndex";
// Bound how many entries we keep on disk so the cache can't grow forever as
// a user accumulates photos over the life of the install.
const MAX_CACHE_ENTRIES = 300;

const store = new MMKV( { id: CACHE_MMKV_ID } );

const getKeyIndex = ( ): string[] => {
  const raw = store.getString( KEY_INDEX_KEY );
  if ( !raw ) return [];
  try {
    return JSON.parse( raw );
  } catch {
    return [];
  }
};

export function getCachedSuggestions<T>( key: string ): T | undefined {
  const raw = store.getString( key );
  if ( !raw ) return undefined;
  try {
    return JSON.parse( raw ) as T;
  } catch {
    return undefined;
  }
}

export function setCachedSuggestions<T>( key: string, value: T ): void {
  store.set( key, JSON.stringify( value ) );

  // Move this key to the most-recently-used end of the index, evicting the
  // oldest entries once we're over the cap.
  const keys = getKeyIndex( ).filter( existingKey => existingKey !== key );
  keys.push( key );
  while ( keys.length > MAX_CACHE_ENTRIES ) {
    const oldestKey = keys.shift( );
    if ( oldestKey ) store.delete( oldestKey );
  }
  store.set( KEY_INDEX_KEY, JSON.stringify( keys ) );
}

export function clearSuggestionsCache( ): void {
  store.clearAll( );
}
