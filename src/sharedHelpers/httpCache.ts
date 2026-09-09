import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "httpCache" );

// A general-purpose offline fallback for the app's HTTP traffic.
//
// The platform's own HTTP cache can't do this job here: every API route this
// app reads answers with `Cache-Control: private, no-cache, no-store`, and
// iNaturalist's client turns any request with a long field set (observation
// detail, at ~3.3KB of query string) into a POST carrying
// `X-HTTP-Method-Override: GET`, which no HTTP cache will store. So we keep
// our own copy, deliberately, on the same reasoning the image cache already
// uses: a private, device-local store of what this user already downloaded is
// a different thing from a shared proxy cache, and `no-store` is aimed at the
// latter.
//
// The one rule that keeps this honest: a stored response is *only* ever
// served when the network attempt fails. With a connection the app behaves
// exactly as it did before — every request goes out, nothing is served stale.
const CACHE_MMKV_ID = "http-response-cache";
const KEY_INDEX_KEY = "__keyIndex";
const ENTRY_PREFIX = "response|";

// Bounds on what we're willing to keep. Entries are whole JSON payloads, and
// observation detail is the big one at a few tens of KB.
const MAX_ENTRIES = 100;
const MAX_BODY_BYTES = 1024 * 1024;

// Credentials and session endpoints. A copy of these is worth nothing offline
// and everything to anyone reading the disk.
const NEVER_CACHE = /(\/oauth\/|\/logout|\/users\/api_token)/i;

const store = new MMKV( { id: CACHE_MMKV_ID } );

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface CacheEntry {
  // The full request key, kept so a hash collision reads as a miss rather
  // than as someone else's response.
  key: string;
  body: string;
  contentType: string;
  cachedAt: number;
}

// djb2, purely to keep MMKV keys short; the entry carries the real key.
/* eslint-disable no-bitwise */
const hashKey = ( key: string ): string => {
  let hash = 5381;
  for ( let i = 0; i < key.length; i += 1 ) {
    hash = ( ( hash << 5 ) + hash + key.charCodeAt( i ) ) | 0;
  }
  return ( hash >>> 0 ).toString( 36 );
};
/* eslint-enable no-bitwise */

// Headers reach fetch either as a Headers instance or as a plain object, and
// header names are case-insensitive in both.
const headerValue = ( headers: unknown, name: string ): string | undefined => {
  let value: string | undefined;
  if ( headers && typeof ( headers as Headers ).get === "function" ) {
    value = ( headers as Headers ).get( name ) ?? undefined;
  } else if ( headers ) {
    const lowerName = name.toLowerCase( );
    value = Object.entries( headers as Record<string, string> ).find(
      ( [key] ) => key.toLowerCase( ) === lowerName,
    )?.[1];
  }
  return value;
};

/**
 * The key a request would be cached under, or null if we won't cache it.
 *
 * Requests that read are cacheable; requests that write are not. That
 * includes the POSTs iNaturalist's client uses to smuggle an over-long GET,
 * which are reads despite the verb — the body is part of the key, since it's
 * carrying what would otherwise be the query string.
 */
export const cacheKeyFor = (
  input: FetchInput,
  init?: FetchInit,
): string | null => {
  const url = typeof input === "string"
    ? input
    : ( input as Request )?.url ?? String( input );
  if ( !url || NEVER_CACHE.test( url ) ) return null;

  const method = String(
    init?.method ?? ( input as Request )?.method ?? "GET",
  ).toUpperCase( );
  const override = headerValue(
    init?.headers ?? ( input as Request )?.headers,
    "X-HTTP-Method-Override",
  );
  const reads = method === "GET" || override?.toUpperCase( ) === "GET";
  if ( !reads ) return null;

  const body = typeof init?.body === "string"
    ? init.body
    : "";
  return `GET ${url}${
    body
      ? ` ${body}`
      : ""}`;
};

const getKeyIndex = ( ): string[] => {
  const raw = store.getString( KEY_INDEX_KEY );
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

const readEntry = ( key: string ): CacheEntry | undefined => {
  const raw = store.getString( ENTRY_PREFIX + hashKey( key ) );
  let entry: CacheEntry | undefined;
  if ( raw ) {
    try {
      entry = JSON.parse( raw ) as CacheEntry;
    } catch {
      entry = undefined;
    }
  }
  return entry?.key === key
    ? entry
    : undefined;
};

const writeEntry = ( key: string, entry: CacheEntry ): void => {
  const storageKey = ENTRY_PREFIX + hashKey( key );
  store.set( storageKey, JSON.stringify( entry ) );

  // Most-recently-written end of the index, evicting the oldest past the cap
  const index = getKeyIndex( ).filter( existing => existing !== storageKey );
  index.push( storageKey );
  while ( index.length > MAX_ENTRIES ) {
    const oldest = index.shift( );
    if ( oldest ) store.delete( oldest );
  }
  store.set( KEY_INDEX_KEY, JSON.stringify( index ) );
};

// Only bodies we can faithfully hand back as a Response. Binary payloads (map
// tiles, photos) would not survive the round trip through a string, and the
// image pipeline caches those itself anyway.
const isStorable = ( response: Response ): boolean => (
  response.ok && !!response.headers?.get( "Content-Type" )?.includes( "json" )
);

const storeResponse = async ( key: string, response: Response ): Promise<void> => {
  if ( !isStorable( response ) ) return;
  try {
    const body = await response.clone( ).text( );
    if ( body.length > MAX_BODY_BYTES ) return;
    writeEntry( key, {
      key,
      body,
      contentType: response.headers.get( "Content-Type" ) || "application/json",
      cachedAt: Date.now( ),
    } );
  } catch ( e ) {
    logger.debug( "failed to cache response", e );
  }
};

/**
 * Wraps a fetch so that a request which can't reach the network is answered
 * from the last response we saw for it, if we have one.
 */
export const createCachedFetch = (
  baseFetch: typeof fetch,
): typeof fetch => async ( input: FetchInput, init?: FetchInit ) => {
  const key = cacheKeyFor( input, init );
  if ( !key ) return baseFetch( input, init );

  let response;
  try {
    response = await baseFetch( input, init );
  } catch ( networkError ) {
    const entry = readEntry( key );
    if ( !entry ) throw networkError;
    logger.info( `offline, answering from cache: ${key.slice( 0, 120 )}` );
    return new Response( entry.body, {
      status: 200,
      headers: { "Content-Type": entry.contentType },
    } );
  }

  // Deliberately not awaited: nothing should wait on us writing to disk
  storeResponse( key, response );
  return response;
};

let installed = false;

/**
 * Puts the cache in front of every request the app makes. Call once, before
 * anything fetches.
 */
export const installHttpCache = ( ): void => {
  if ( installed ) return;
  installed = true;
  global.fetch = createCachedFetch( global.fetch );
};

// Responses to authenticated requests are in here, so nothing survives a
// user signing out.
export const clearHttpCache = ( ): void => {
  store.clearAll( );
};
