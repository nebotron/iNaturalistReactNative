import {
  CachesDirectoryPath, mkdir, readFile, unlink, writeFile,
} from "@dr.pogodin/react-native-fs";
import { onlineManager } from "@tanstack/react-query";
import { MMKV } from "react-native-mmkv";

// A disk cache under fetch: every successful JSON GET is saved, and served
// again when the app is offline or the request fails to reach the server. It
// keeps whatever was recently viewed (Explore's tabs, the map's place, taxa,
// users...) usable offline without each screen saving its own results. Online,
// requests go to the network first, unless the caller marked the request's
// signal with preferCachedResponse and a fresh enough copy is cached.

// Entries not fetched or read for this long are dropped
export const HTTP_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Least recently used entries are dropped past these
const MAX_ENTRIES = 500;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
// A response larger than this isn't worth a slot
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
// How old a cached response may be and still be used instead of the network,
// for requests marked with preferCachedResponse
export const HTTP_CACHE_FRESH_MS = 2 * 60 * 60 * 1000;
// Reads and writes arriving together save the index once
const INDEX_WRITE_DELAY_MS = 1000;

// Responses that hand out credentials are never written to disk
const UNCACHEABLE_URL = /api_token|oauth|\/token\b|jwt/i;

const HTTP_CACHE_PATH = `${CachesDirectoryPath}/inatHttpCache`;

// Header set on responses served from the cache, holding when they were fetched
export const CACHED_AT_HEADER = "x-inat-cached-at";

// Signals of requests that take a fresh cached response over the network.
// Marking the signal rather than the request lets callers opt in through
// inatjs, which passes the signal on but not custom headers.
const cacheFirstSignals = new WeakSet<AbortSignal>( );
export const preferCachedResponse = ( signal: AbortSignal ) => {
  cacheFirstSignals.add( signal );
  return signal;
};

interface IndexEntry {
  // Name of the file holding the body
  file: string;
  // When the response was fetched
  fetchedAt: number;
  // When it was last fetched or served
  usedAt: number;
  bytes: number;
  contentType: string;
}

type Index = Record<string, IndexEntry>;

interface HttpCacheStore {
  read: ( file: string ) => Promise<string>;
  write: ( file: string, body: string ) => Promise<void>;
  remove: ( file: string ) => Promise<void>;
  clear: ( ) => Promise<void>;
}

const fileStore: HttpCacheStore = {
  read: file => readFile( `${HTTP_CACHE_PATH}/${file}`, "utf8" ),
  write: async ( file, body ) => {
    await mkdir( HTTP_CACHE_PATH );
    await writeFile( `${HTTP_CACHE_PATH}/${file}`, body, "utf8" );
  },
  remove: async file => {
    await unlink( `${HTTP_CACHE_PATH}/${file}` ).catch( ( ) => undefined );
  },
  clear: async ( ) => {
    await unlink( HTTP_CACHE_PATH ).catch( ( ) => undefined );
  },
};

// cyrb53: a fast 53-bit string hash, for file names. The index keeps the full
// key, so a collision only costs a miss.
/* eslint-disable no-bitwise */
const hash = ( str: string ) => {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for ( let i = 0; i < str.length; i += 1 ) {
    const ch = str.charCodeAt( i );
    h1 = Math.imul( h1 ^ ch, 2654435761 );
    h2 = Math.imul( h2 ^ ch, 1597334677 );
  }
  h1 = Math.imul( h1 ^ ( h1 >>> 16 ), 2246822507 ) ^ Math.imul( h2 ^ ( h2 >>> 13 ), 3266489909 );
  h2 = Math.imul( h2 ^ ( h2 >>> 16 ), 2246822507 ) ^ Math.imul( h1 ^ ( h1 >>> 13 ), 3266489909 );
  return ( 4294967296 * ( 2097151 & h2 ) + ( h1 >>> 0 ) ).toString( 36 );
};
/* eslint-enable no-bitwise */

type HeadersLike = Headers | Record<string, string> | [string, string][] | undefined;

const getHeader = ( headers: HeadersLike, name: string ): string | null => {
  if ( !headers ) return null;
  if ( typeof ( headers as Headers ).get === "function" ) {
    return ( headers as Headers ).get( name );
  }
  const lower = name.toLowerCase( );
  const entries = Array.isArray( headers )
    ? headers
    : Object.entries( headers );
  return entries.find( ( [key] ) => key.toLowerCase( ) === lower )?.[1] ?? null;
};

// Who a request is made as, so one account's results are never served to
// another. Only the user ID is kept, never the token.
export const requesterOf = ( authorization: string | null | undefined ): string => {
  if ( !authorization ) return "none";
  const payload = authorization.replace( /^Bearer\s+/i, "" ).split( "." )[1];
  if ( !payload ) return `token:${hash( authorization )}`;
  try {
    const base64 = payload.replace( /-/g, "+" ).replace( /_/g, "/" )
      .padEnd( Math.ceil( payload.length / 4 ) * 4, "=" );
    const json = JSON.parse( global.atob( base64 ) );
    if ( json.user_id ) return `user:${json.user_id}`;
    if ( json.application ) return `app:${json.application}`;
  } catch {
    // Not a JWT we can read
  }
  return `token:${hash( authorization )}`;
};

// The cache key for a request, or null if it isn't one to cache. inatjs
// sends a long GET as a POST with X-HTTP-Method-Override, so those count too,
// keyed by their body.
const describeRequest = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): string | null => {
  const request = typeof input === "object" && "url" in input && !( input instanceof URL )
    ? input as Request
    : undefined;
  const url = request?.url ?? String( input );
  if ( !/^https?:\/\//.test( url ) || UNCACHEABLE_URL.test( url ) ) return null;
  const headers = ( init?.headers ?? request?.headers ) as HeadersLike;
  const method = ( init?.method ?? request?.method ?? "GET" ).toUpperCase( );
  const override = getHeader( headers, "X-HTTP-Method-Override" )?.toUpperCase( );
  const isGet = method === "GET" || ( method === "POST" && override === "GET" );
  if ( !isGet ) return null;
  const body = init?.body;
  if ( body != null && typeof body !== "string" ) return null;
  const requester = requesterOf( getHeader( headers, "Authorization" ) );
  return [requester, url, body].filter( Boolean ).join( " " );
};

const ANONYMOUS_PREFIX = `${requesterOf( null )} `;

// What an anonymous request's key asks for, whoever made it
const resourceOf = ( key: string ) => (
  key.startsWith( ANONYMOUS_PREFIX )
    ? key.slice( ANONYMOUS_PREFIX.length )
    : null
);

interface Options {
  fetch: typeof fetch;
  store?: HttpCacheStore;
  storage?: MMKV;
  isOnline?: ( ) => boolean;
  indexWriteDelayMs?: number;
  onError?: ( message: string, error: unknown ) => void;
}

interface HttpCache {
  fetch: typeof fetch;
  clear: ( ) => Promise<void>;
  // Saves the index now rather than after the write delay
  flush: ( ) => void;
}

const INDEX_KEY = "index";

// The logger can't be imported here, since it imports inatjs, which has to
// load after the cache is installed
let errorHandler: ( message: string, error: unknown ) => void = ( ) => undefined;
export const setHttpCacheErrorHandler = ( handler: typeof errorHandler ) => {
  errorHandler = handler;
};

export const createHttpCache = ( {
  fetch: networkFetch,
  store = fileStore,
  storage = new MMKV( { id: "http-cache" } ),
  isOnline = ( ) => onlineManager.isOnline( ),
  indexWriteDelayMs = INDEX_WRITE_DELAY_MS,
  onError = ( message, error ) => errorHandler( message, error ),
}: Options ): HttpCache => {
  let index: Index | undefined;
  let indexTimer: ReturnType<typeof setTimeout> | undefined;

  const getIndex = ( ): Index => {
    if ( !index ) {
      try {
        index = JSON.parse( storage.getString( INDEX_KEY ) ?? "{}" ) as Index;
      } catch {
        index = {};
      }
    }
    return index;
  };

  const flush = ( ) => {
    clearTimeout( indexTimer );
    indexTimer = undefined;
    if ( index ) storage.set( INDEX_KEY, JSON.stringify( index ) );
  };

  const scheduleIndexWrite = ( ) => {
    if ( indexTimer ) return;
    indexTimer = setTimeout( flush, indexWriteDelayMs );
  };

  const drop = ( key: string ) => {
    const entries = getIndex( );
    const entry = entries[key];
    if ( !entry ) return;
    delete entries[key];
    // Another key could have been given the same file since
    if ( !Object.values( entries ).some( other => other.file === entry.file ) ) {
      store.remove( entry.file ).catch( error => onError( "remove", error ) );
    }
  };

  // Drops the expired, then the least recently used past the limits
  const prune = ( ) => {
    const entries = getIndex( );
    const now = Date.now( );
    Object.entries( entries ).forEach( ( [key, entry] ) => {
      if ( now - entry.usedAt >= HTTP_CACHE_TTL_MS ) drop( key );
    } );
    const newestFirst = Object.entries( entries ).sort( ( a, b ) => b[1].usedAt - a[1].usedAt );
    let totalBytes = 0;
    newestFirst.forEach( ( [key, entry], i ) => {
      totalBytes += entry.bytes;
      if ( i >= MAX_ENTRIES || totalBytes > MAX_TOTAL_BYTES ) drop( key );
    } );
  };

  const save = async ( key: string, body: string, contentType: string ) => {
    if ( body.length > MAX_ENTRY_BYTES ) return;
    const file = `${hash( key )}.json`;
    try {
      await store.write( file, body );
    } catch ( error ) {
      onError( "write", error );
      return;
    }
    const now = Date.now( );
    getIndex( )[key] = {
      file,
      fetchedAt: now,
      usedAt: now,
      bytes: body.length,
      contentType,
    };
    prune( );
    scheduleIndexWrite( );
  };

  // When the app last changed something on the server; responses fetched
  // before then may be out of date, so they aren't used ahead of the network
  let lastWriteAt = 0;

  // When an anonymous request misses, the key of the latest response to the
  // same request made as someone. A signed-in user's requests go out without
  // a token once it expires and can't be refreshed, as when they've been
  // offline for an hour, and would otherwise miss everything they viewed.
  // Signing out clears the cache, so whoever the response was fetched as is
  // the person using the app.
  const keyForAnonymous = ( key: string ): string | null => {
    const resource = resourceOf( key );
    if ( !resource ) return null;
    const suffix = ` ${resource}`;
    const latest = Object.entries( getIndex( ) ).reduce<[string, IndexEntry] | null>(
      ( best, entry ) => (
        entry[0] !== key
        && entry[0].endsWith( suffix )
        && ( !best || entry[1].fetchedAt > best[1].fetchedAt )
          ? entry
          : best
      ),
      null,
    );
    return latest?.[0] ?? null;
  };

  // The cached response, if there is one. With fresh, only one fetched within
  // HTTP_CACHE_FRESH_MS and since the last write. With anyRequester, an
  // anonymous request can be answered with a response fetched as the user.
  const serve = async (
    requestKey: string,
    { fresh = false, anyRequester = false }: { fresh?: boolean; anyRequester?: boolean } = {},
  ): Promise<Response | null> => {
    let key = requestKey;
    if ( anyRequester && !getIndex( )[key] ) key = keyForAnonymous( key ) ?? key;
    const entry = getIndex( )[key];
    if ( !entry ) return null;
    const age = Date.now( ) - entry.fetchedAt;
    if ( age >= HTTP_CACHE_TTL_MS ) {
      drop( key );
      scheduleIndexWrite( );
      return null;
    }
    if ( fresh && ( age >= HTTP_CACHE_FRESH_MS || entry.fetchedAt < lastWriteAt ) ) {
      return null;
    }
    let body: string;
    try {
      body = await store.read( entry.file );
    } catch {
      // The OS can clear the caches directory
      drop( key );
      scheduleIndexWrite( );
      return null;
    }
    entry.usedAt = Date.now( );
    scheduleIndexWrite( );
    return new Response( body, {
      status: 200,
      headers: {
        "Content-Type": entry.contentType,
        [CACHED_AT_HEADER]: String( entry.fetchedAt ),
      },
    } );
  };

  // Saves the body once the caller reads it, rather than reading it twice
  const saveWhenRead = ( response: Response, key: string, contentType: string ) => {
    const readText = response.text.bind( response );
    let saved = false;
    response.text = async ( ) => {
      const body = await readText( );
      if ( !saved ) {
        saved = true;
        save( key, body, contentType ).catch( error => onError( "save", error ) );
      }
      return body;
    };
  };

  const cachedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const key = describeRequest( input, init );
    if ( !key ) {
      const method = ( init?.method ?? "GET" ).toUpperCase( );
      if ( method !== "GET" && method !== "HEAD" ) lastWriteAt = Date.now( );
      return networkFetch( input, init );
    }

    // Offline, a request would only fail, perhaps after a long wait
    if ( !isOnline( ) ) {
      const cached = await serve( key, { anyRequester: true } );
      if ( cached ) return cached;
    } else if ( init?.signal && cacheFirstSignals.has( init.signal ) ) {
      const cached = await serve( key, { fresh: true } );
      if ( cached ) return cached;
    }

    let response: Response;
    try {
      response = await networkFetch( input, init );
    } catch ( error ) {
      // Couldn't reach the server, or timed out
      const cached = await serve( key, { anyRequester: true } );
      if ( cached ) return cached;
      throw error;
    }

    const contentType = response.headers?.get?.( "Content-Type" ) ?? "";
    if ( response.status === 200 && /json/i.test( contentType ) ) {
      saveWhenRead( response, key, contentType );
    }
    return response;
  };

  const clear = async ( ) => {
    clearTimeout( indexTimer );
    indexTimer = undefined;
    index = {};
    storage.clearAll( );
    await store.clear( ).catch( error => onError( "clear", error ) );
  };

  return { fetch: cachedFetch as typeof fetch, clear, flush };
};

let installed: HttpCache | undefined;

// Replaces the global fetch with the cached one. Has to run before anything
// keeps its own reference to fetch, as inatjs does when it's first imported.
export const installHttpCache = ( options: Partial<Options> = {} ) => {
  if ( installed || typeof global.fetch !== "function" ) return installed;
  installed = createHttpCache( { fetch: global.fetch.bind( global ), ...options } );
  global.fetch = installed.fetch;
  return installed;
};

export const clearHttpCache = async ( ) => {
  await installed?.clear( );
};
