import type { ApiObservation } from "api/types";
import { MMKV } from "react-native-mmkv";

// Persists the Notifications tab to disk so it survives app restarts and can
// be read with no network. Notifications are the one screen a user opens
// *because* something happened while they weren't looking, and the update
// itself ("so-and-so added an ID") is already fully described by the payload
// we fetched last time online — there's nothing to recompute, so there's no
// reason a subway ride should turn the tab into an offline notice.
//
// Alongside the list we keep the full detail of the observations those
// notifications point at, so tapping one offline opens the observation with
// its comments and identifications instead of a spinner.
const CACHE_MMKV_ID = "notifications-cache";
const NOTIFICATIONS_PREFIX = "notifications|";
const OBSERVATION_PREFIX = "observation|";
const OBSERVATION_INDEX_KEY = "__observationIndex";

// A page of updates from the API, i.e. everything the tab shows before the
// user scrolls. Later pages are cheap to re-fetch and unlikely to be what
// someone opens the app offline to check.
export const MAX_CACHED_NOTIFICATIONS = 30;

// Observation detail is much heavier than an update, so we keep fewer of
// them than we keep notifications.
export const MAX_CACHED_OBSERVATIONS = 20;

const store = new MMKV( { id: CACHE_MMKV_ID } );

export interface CacheEntry<T> {
  // When this was written, so callers can hand React Query an honest
  // initialDataUpdatedAt and let it decide whether to refetch.
  cachedAt: number;
  value: T;
}

const read = <T>( key: string ): CacheEntry<T> | undefined => {
  const raw = store.getString( key );
  let entry: CacheEntry<T> | undefined;
  if ( raw ) {
    try {
      entry = JSON.parse( raw ) as CacheEntry<T>;
    } catch {
      entry = undefined;
    }
  }
  return entry;
};

const write = <T>( key: string, value: T ): void => {
  store.set( key, JSON.stringify( { cachedAt: Date.now( ), value } ) );
};

export function getCachedNotifications<T>( cacheKey: string ): CacheEntry<T[]> | undefined {
  return read<T[]>( NOTIFICATIONS_PREFIX + cacheKey );
}

export function setCachedNotifications<T>( cacheKey: string, notifications: T[] ): void {
  write( NOTIFICATIONS_PREFIX + cacheKey, notifications.slice( 0, MAX_CACHED_NOTIFICATIONS ) );
}

const getObservationIndex = ( ): string[] => {
  const raw = store.getString( OBSERVATION_INDEX_KEY );
  let index: string[] = [];
  if ( raw ) {
    try {
      index = JSON.parse( raw );
    } catch {
      index = [];
    }
  }
  return index;
};

export function getCachedObservation( uuid: string ): CacheEntry<ApiObservation> | undefined {
  return read<ApiObservation>( OBSERVATION_PREFIX + uuid );
}

export function setCachedObservations( observations: ApiObservation[] ): void {
  const uuids = observations.map( observation => observation?.uuid ).filter( Boolean );
  observations.forEach( observation => {
    if ( observation?.uuid ) write( OBSERVATION_PREFIX + observation.uuid, observation );
  } );

  // Move everything we just wrote to the most-recently-used end of the index
  // and evict the oldest past the cap, so a year of notifications can't
  // accumulate observation detail on disk forever.
  const index = getObservationIndex( ).filter( uuid => !uuids.includes( uuid ) );
  index.push( ...uuids );
  while ( index.length > MAX_CACHED_OBSERVATIONS ) {
    const oldestUuid = index.shift( );
    if ( oldestUuid ) store.delete( OBSERVATION_PREFIX + oldestUuid );
  }
  store.set( OBSERVATION_INDEX_KEY, JSON.stringify( index ) );
}

// Notifications are about one signed-in user's content, so nothing here
// should outlive their session.
export function clearNotificationsCache( ): void {
  store.clearAll( );
}
