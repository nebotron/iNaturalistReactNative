import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "hotspotRequestCache" );

// Responses the Hotspots view fetches (iNaturalist observation searches, OSRM
// routes and travel times, address suggestions), kept on disk for a day so
// reopening the view, replanning the same trip, or retyping an address doesn't
// ask the server again. A separate MMKV instance, so cloud backup (which only
// mirrors the instances it lists) leaves it out.
const storage = new MMKV( { id: "hotspot-request-cache" } );

export const REQUEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Requests in progress, so the same request made twice at once is sent once
const inFlight = new Map<string, Promise<unknown>>( );

// When each of a namespace's entries was stored, kept in one key so pruning
// doesn't read every entry
const indexKey = ( namespace: string ) => `${namespace}#index`;

function readIndex( namespace: string ): Record<string, number> {
  try {
    return JSON.parse( storage.getString( indexKey( namespace ) ) ?? "{}" );
  } catch {
    return {};
  }
}

function store( namespace: string, maxEntries: number, key: string, value: unknown ) {
  const now = Date.now( );
  const index = { ...readIndex( namespace ), [key]: now };
  const newestFirst = Object.entries( index ).sort( ( a, b ) => b[1] - a[1] );
  const kept = newestFirst
    .filter( ( [, at] ) => now - at < REQUEST_CACHE_TTL_MS )
    .slice( 0, maxEntries );
  const keptKeys = new Set( kept.map( ( [k] ) => k ) );
  newestFirst.forEach( ( [k] ) => {
    if ( !keptKeys.has( k ) ) storage.delete( k );
  } );
  storage.set( key, JSON.stringify( value ) );
  storage.set( indexKey( namespace ), JSON.stringify( Object.fromEntries( kept ) ) );
}

// Returns the stored response to the request `keyParts` describes if it's under
// a day old, otherwise fetches it and stores the result when `shouldStore`
// accepts it. A failed fetch is never stored.
export function cachedRequest<T>(
  namespace: string,
  maxEntries: number,
  keyParts: unknown,
  fetcher: ( ) => Promise<T>,
  shouldStore: ( value: T ) => boolean = ( ) => true,
): Promise<T> {
  const key = `${namespace}:${JSON.stringify( keyParts )}`;
  const pending = inFlight.get( key );
  if ( pending ) return pending as Promise<T>;

  const storedAt = readIndex( namespace )[key];
  if ( storedAt && Date.now( ) - storedAt < REQUEST_CACHE_TTL_MS ) {
    const raw = storage.getString( key );
    if ( raw ) {
      try {
        return Promise.resolve( JSON.parse( raw ) as T );
      } catch {
        // Unreadable entry: fetch it again below
      }
    }
  }

  const promise = fetcher( ).then( value => {
    if ( shouldStore( value ) ) {
      try {
        store( namespace, maxEntries, key, value );
      } catch ( error ) {
        logger.error( "Failed to store hotspot response", error );
      }
    }
    return value;
  } ).finally( ( ) => inFlight.delete( key ) );
  inFlight.set( key, promise );
  return promise;
}
