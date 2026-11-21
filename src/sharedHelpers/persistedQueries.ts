import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { hashKey } from "@tanstack/react-query";
import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "persistedQueries" );

// How long a persisted query's results are kept, on disk and in memory, and
// shown without asking the server again. Explore's results use this. Pulling
// to refresh fetches new ones sooner.
export const PERSISTED_QUERY_TTL_MS = 48 * 60 * 60 * 1000;

// Distinct queries (e.g. filter sets) kept on disk; the least recently
// fetched are dropped past this
const MAX_ENTRIES = 30;
// Pages of an infinite query kept on disk. Whatever was scrolled to past this
// is fetched again after a restart.
const MAX_PAGES = 10;
// A page arriving while scrolling waits this long, so a burst of pages is
// written once
const WRITE_DELAY_MS = 1000;

// Marks a query whose results are saved to disk and restored after a restart
export const PERSISTED_QUERY_META = { persist: true };

// A separate MMKV instance, so cloud backup (which only mirrors the instances
// it lists) leaves it out and it can be cleared on its own
const storage = new MMKV( { id: "persisted-queries" } );

const INDEX_KEY = "#index";

interface Entry {
  data: unknown;
  dataUpdatedAt: number;
}

// When each entry's data was fetched, by query hash, kept in one key so
// pruning doesn't read every entry
function readIndex( ): Record<string, number> {
  try {
    return JSON.parse( storage.getString( INDEX_KEY ) ?? "{}" );
  } catch {
    return {};
  }
}

const isExpired = ( dataUpdatedAt: number ) => (
  Date.now( ) - dataUpdatedAt >= PERSISTED_QUERY_TTL_MS
);

interface InfiniteData {
  pages: unknown[];
  pageParams: unknown[];
}

const isInfiniteData = ( data: unknown ): data is InfiniteData => (
  !!data
  && typeof data === "object"
  && Array.isArray( ( data as InfiniteData ).pages )
  && Array.isArray( ( data as InfiniteData ).pageParams )
);

// JSON turns the first page's undefined page param into null, which the page
// param helpers would take for a real page
const restorePageParams = ( data: unknown ) => (
  isInfiniteData( data )
    ? {
      ...data,
      pageParams: data.pageParams.map( param => ( param === null
        ? undefined
        : param ) ),
    }
    : data
);

const truncatePages = ( data: unknown ) => (
  isInfiniteData( data )
    ? {
      ...data,
      pages: data.pages.slice( 0, MAX_PAGES ),
      pageParams: data.pageParams.slice( 0, MAX_PAGES ),
    }
    : data
);

// When the results saved for this query key were fetched, if that was within
// the TTL. Reads only the index.
export function readPersistedQueryUpdatedAt( queryKey: QueryKey ): number | undefined {
  const dataUpdatedAt = readIndex( )[hashKey( queryKey )];
  return dataUpdatedAt && !isExpired( dataUpdatedAt )
    ? dataUpdatedAt
    : undefined;
}

// The results saved for this query key, if they were fetched within the TTL
export function readPersistedQuery( queryKey: QueryKey ): unknown {
  const raw = readPersistedQueryUpdatedAt( queryKey )
    ? storage.getString( hashKey( queryKey ) )
    : undefined;
  let data;
  try {
    data = raw
      ? restorePageParams( ( JSON.parse( raw ) as Entry ).data )
      : undefined;
  } catch ( error ) {
    logger.warn( "Discarding an unreadable persisted query", error );
  }
  return data;
}

function writeQuery( query: Query ) {
  const { data, dataUpdatedAt } = query.state;
  if ( data === undefined || !dataUpdatedAt ) return;
  const hash = query.queryHash;
  const index = { ...readIndex( ), [hash]: dataUpdatedAt };
  const newestFirst = Object.entries( index ).sort( ( a, b ) => b[1] - a[1] );
  const kept = newestFirst
    .filter( ( [, at] ) => !isExpired( at ) )
    .slice( 0, MAX_ENTRIES );
  const keptHashes = new Set( kept.map( ( [k] ) => k ) );
  newestFirst.forEach( ( [k] ) => {
    if ( !keptHashes.has( k ) ) storage.delete( k );
  } );
  if ( keptHashes.has( hash ) ) {
    const entry: Entry = { data: truncatePages( data ), dataUpdatedAt };
    storage.set( hash, JSON.stringify( entry ) );
  }
  storage.set( INDEX_KEY, JSON.stringify( Object.fromEntries( kept ) ) );
}

// Saves the results of queries marked with PERSISTED_QUERY_META whenever they
// change. They're read back lazily, by the hook that makes the query, with
// readPersistedQuery. Returns a function that stops saving.
export function persistQueries(
  queryClient: QueryClient,
  { writeDelayMs = WRITE_DELAY_MS }: { writeDelayMs?: number } = {},
): ( ) => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>( );
  return queryClient.getQueryCache( ).subscribe( event => {
    const { query } = event;
    if ( !query.meta?.persist ) return;
    if ( event.type !== "updated" || event.action.type !== "success" ) return;
    clearTimeout( timers.get( query.queryHash ) );
    timers.set( query.queryHash, setTimeout( ( ) => {
      timers.delete( query.queryHash );
      try {
        writeQuery( query );
      } catch ( error ) {
        logger.error( "Failed to persist query", error );
      }
    }, writeDelayMs ) );
  } );
}

export function clearPersistedQueries( ) {
  storage.clearAll( );
}
