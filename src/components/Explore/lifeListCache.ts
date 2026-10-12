import { searchObservations } from "api/observations";
import type { ApiObservation } from "api/types";
import type { Lifer } from "components/LifeList/LifeListContainer";
import { fetchMissingDisplayData, toLifer } from "components/LifeList/LifeListContainer";
import { log } from "sharedHelpers/logger";
import { withRequestTimeout } from "sharedHelpers/logging";
import { OBSERVATION_SYNC_FIELDS } from "sharedHelpers/userObservationsCache";
import { zustandStorage } from "stores/useStore";

const logger = log.extend( "exploreLifeListCache" );

const PAGE_SIZE = 200;
// Safety valve so a huge result set can't loop forever; 500 pages is 100k obs.
const MAX_PAGES = 500;
// Persist progress this often, so an interrupted first sync resumes rather than
// starting over, without re-serializing everything on every page.
const SAVE_EVERY_PAGES = 10;
// How many distinct filter sets keep a cache before the oldest is dropped.
const MAX_CACHED_QUERIES = 10;

// Params that only shape the request, not which observations match.
const NON_FILTER_PARAMS = ["fields", "locale", "order", "order_by", "page", "per_page", "ttl"];

// uuid, the species it records, and its observed_on date.
type Entry = [string, number, string | null];

interface LifeListCache {
  entries: Entry[];
  // Taxon and photo for the earliest observation of each species, by uuid.
  display: Record<string, Lifer>;
  lastSync: string | null;
  // Where an unfinished sync left off, so the next one resumes from there.
  pending?: { idAbove?: number; startedAt: string; updatedSince: string | null };
}

const INDEX_KEY = "exploreLifeList-v1-index";

export const lifeListCacheKey = ( queryParams: Record<string, unknown> ): string => {
  const filters = Object.keys( queryParams )
    .filter( key => !NON_FILTER_PARAMS.includes( key ) && queryParams[key] !== undefined )
    .sort( )
    .map( key => [key, queryParams[key]] );
  return `exploreLifeList-v1-${JSON.stringify( filters )}`;
};

const readCache = ( key: string ): LifeListCache => {
  const raw = zustandStorage.getItem( key );
  if ( typeof raw === "string" ) {
    try {
      return JSON.parse( raw );
    } catch ( error ) {
      logger.warn( "Discarding an unreadable life list cache", error );
    }
  }
  return { entries: [], display: {}, lastSync: null };
};

// Most recently used first; anything past the limit is removed from storage.
const touchIndex = ( key: string ) => {
  const raw = zustandStorage.getItem( INDEX_KEY );
  let index: string[] = [];
  try {
    index = typeof raw === "string"
      ? JSON.parse( raw )
      : [];
  } catch {
    index = [];
  }
  index = [key, ...index.filter( k => k !== key )];
  index.slice( MAX_CACHED_QUERIES ).forEach( k => zustandStorage.removeItem( k ) );
  zustandStorage.setItem( INDEX_KEY, JSON.stringify( index.slice( 0, MAX_CACHED_QUERIES ) ) );
};

const isEarlier = ( date: string | null, than: string | null | undefined ) => (
  !!date && ( !than || date < than )
);

const earliestBySpecies = ( entries: Map<string, Entry> ): Map<number, Entry> => {
  const earliest = new Map<number, Entry>( );
  entries.forEach( entry => {
    const existing = earliest.get( entry[1] );
    if ( !existing || isEarlier( entry[2], existing[2] ) ) {
      earliest.set( entry[1], entry );
    }
  } );
  return earliest;
};

// Each species once, as its earliest observation, newest first.
const toLifers = ( entries: Map<string, Entry>, display: Record<string, Lifer> ): Lifer[] => (
  Array.from( earliestBySpecies( entries ).values( ) )
    .map( ( [uuid] ) => display[uuid] )
    .filter( Boolean )
    .sort( ( a, b ) => ( b.observed_on ?? "" ).localeCompare( a.observed_on ?? "" ) )
);

export const readCachedLifeList = ( key: string ): Lifer[] => {
  const { entries, display } = readCache( key );
  return toLifers( new Map( entries.map( entry => [entry[0], entry] ) ), display );
};

// Brings the cache for these filters up to date and returns the life list. The
// first run pages every matching observation; after that only those created
// or updated since the last sync are fetched, like the My Lifers sync.
// Observations that stop matching the filters, or are deleted, aren't seen by
// an incremental sync, so they stay until the cache is evicted.
export const syncLifeList = async (
  queryParams: Record<string, unknown>,
  opts: { api_token: string | null },
  { onProgress, shouldStop }: {
    onProgress?: ( lifers: Lifer[] ) => void;
    // Checked between pages, so a sync for filters the user has moved on from
    // stops and saves its place rather than paging on alongside the new one.
    shouldStop?: ( ) => boolean;
  } = {},
): Promise<Lifer[]> => {
  const key = lifeListCacheKey( queryParams );
  touchIndex( key );
  const stored = readCache( key );
  const entries = new Map( stored.entries.map( entry => [entry[0], entry] ) );
  const { display } = stored;
  const { startedAt, updatedSince } = stored.pending ?? {
    startedAt: new Date( ).toISOString( ),
    updatedSince: stored.lastSync,
  };
  let idAbove = stored.pending?.idAbove;

  const save = ( done: boolean ) => {
    const lifers = toLifers( entries, display );
    const pruned: Record<string, Lifer> = {};
    lifers.forEach( lifer => { pruned[lifer.uuid] = lifer; } );
    zustandStorage.setItem( key, JSON.stringify( {
      entries: Array.from( entries.values( ) ),
      display: pruned,
      lastSync: done
        ? startedAt
        : stored.lastSync,
      pending: done
        ? undefined
        : { idAbove, startedAt, updatedSince },
    } ) );
  };

  let done = false;
  try {
    for ( let page = 1; page <= MAX_PAGES; page += 1 ) {
      if ( page > 1 && shouldStop?.( ) ) {
        save( false );
        return toLifers( entries, display );
      }
      const params = {
        ...queryParams,
        order_by: "id",
        order: "asc",
        per_page: PAGE_SIZE,
        fields: OBSERVATION_SYNC_FIELDS,
        ttl: -1,
        ...( idAbove === undefined
          ? {}
          : { id_above: idAbove } ),
        ...( updatedSince
          ? { updated_since: updatedSince }
          : {} ),
      };
      // eslint-disable-next-line no-await-in-loop
      const response = await withRequestTimeout(
        opts,
        requestOpts => searchObservations( params, requestOpts ),
      );
      const results: ApiObservation[] | undefined = response?.results;
      if ( !Array.isArray( results ) ) {
        throw new Error( `Unreadable life list page ${page}` );
      }
      const earliest = earliestBySpecies( entries );
      results.forEach( obs => {
        const lifer = toLifer( obs );
        if ( !lifer?.speciesId ) {
          // Re-identified above species level
          entries.delete( obs.uuid );
          return;
        }
        const current = earliest.get( lifer.speciesId );
        if ( !current || current[0] === obs.uuid || isEarlier( lifer.observed_on, current[2] ) ) {
          display[obs.uuid] = lifer;
        }
        entries.set( obs.uuid, [obs.uuid, lifer.speciesId, lifer.observed_on] );
      } );
      const lastId = results[results.length - 1]?.id;
      if ( results.length < PAGE_SIZE || typeof lastId !== "number" ) {
        done = true;
        break;
      }
      idAbove = lastId;
      onProgress?.( toLifers( entries, display ) );
      if ( page % SAVE_EVERY_PAGES === 0 ) save( false );
    }
  } catch ( error ) {
    save( false );
    throw error;
  }

  // An earliest observation whose display was pruned while it wasn't the
  // earliest, e.g. after the previous earliest was re-dated.
  try {
    await fetchMissingDisplayData(
      Array.from( earliestBySpecies( entries ).values( ) )
        .map( ( [uuid] ) => uuid )
        .filter( uuid => !display[uuid] ),
      display,
      opts,
    );
  } catch ( error ) {
    logger.warn( "Could not fetch display data for every species", error );
  }
  save( done );
  return toLifers( entries, display );
};
