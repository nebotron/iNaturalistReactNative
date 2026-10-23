import { searchObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import { MMKV } from "react-native-mmkv";
import Taxon from "realmModels/Taxon";
import { log } from "sharedHelpers/logger";
import { withRequestTimeout } from "sharedHelpers/logging";
import { USER_OBSERVATIONS_MMKV_ID } from "sharedHelpers/mmkvRecordStore";
import zustandMMKVBackingStorage from "stores/zustandMMKVBackingStorage";

const logger = log.extend( "userObservationsCache" );

// One local cache of the signed-in user's observation history, shared by every
// feature that has to reason about all of it rather than the handful Realm
// keeps, so whichever screen is opened first pays for the sync.
//
// Realm isn't the right home for this: it holds only the most recent page of
// remote observations plus whatever this device created.

// Max page size the API allows.
const PAGE_SIZE = 200;
// Safety valve so a huge history can't loop forever; 500 pages is 100k obs.
const MAX_PAGES = 500;

export interface CachedObservation {
  uuid: string;
  // Favorited by at least one user, i.e. it has a vote with a null scope.
  faved: boolean;
  researchGrade: boolean;
  // The species this observation records, which is not always the taxon it was
  // identified as. See speciesIdFromTaxon. Null when the identification is
  // coarser than a species.
  speciesId: number | null;
}

// An identification below species level is still an observation of the
// species: the Rock Pigeons people photograph on the street are usually
// identified as the domestic variety (Columba livia domestica, rank_level 5),
// and those are observations of Columba livia. Keying anything off the
// identified taxon alone counts a species as never seen until it happens to be
// identified at exactly species level, so a common bird can turn up as a lifer
// years after the fact.
//
// ancestor_ids runs root to leaf and ends with the taxon's own id, so the entry
// before it is the parent. Every rank below species on iNaturalist hangs
// directly off its species, so the parent is the species.
export const speciesIdFromTaxon = (
  taxon: ApiTaxon | null | undefined,
): number | null => {
  const rankLevel = taxon?.rank_level;
  if ( !taxon?.id || typeof rankLevel !== "number" ) return null;
  if ( rankLevel > Taxon.SPECIES_LEVEL ) return null;
  if ( rankLevel === Taxon.SPECIES_LEVEL ) return taxon.id;
  const ancestorIds = ( taxon.ancestor_ids ?? [] ).filter( id => id !== taxon.id );
  return ancestorIds[ancestorIds.length - 1] ?? null;
};

export type UserObservationsCache = Map<string, CachedObservation>;

// Kept in its own MMKV instance, split into buckets by uuid, so a sync that
// changes a few observations rewrites only the buckets they fall in rather than
// the whole history.
const store = new MMKV( { id: USER_OBSERVATIONS_MMKV_ID } );
const BUCKETS = 64;
const bucketKey = ( userId: number, bucket: number ) => `${userId}:${bucket}`;
const lastSyncKey = ( userId: number ) => `${userId}:lastSync`;

const bucketOf = ( uuid: string ): number => {
  let hash = 5381;
  for ( let i = 0; i < uuid.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( ( hash << 5 ) + hash ) ^ uuid.charCodeAt( i ) ) >>> 0;
  }
  return hash % BUCKETS;
};

// Stored as positional tuples rather than objects: a full history is tens of
// thousands of entries, and the key names would be most of the payload.
type CachedObservationTuple = [string, 0 | 1, 0 | 1, number | null];

const toTuple = ( observation: CachedObservation ): CachedObservationTuple => [
  observation.uuid,
  observation.faved
    ? 1
    : 0,
  observation.researchGrade
    ? 1
    : 0,
  observation.speciesId,
];

const fromTuple = ( tuple: CachedObservationTuple ): CachedObservation => ( {
  uuid: tuple[0],
  faved: tuple[1] === 1,
  researchGrade: tuple[2] === 1,
  speciesId: tuple[3],
} );

// v2 kept the whole history as one blob of 7-field tuples in the default
// instance; move it here so an upgrade doesn't have to re-sync from scratch.
const migrateV2 = ( userId: number ) => {
  const key = `userObservations-v2-${userId}`;
  const raw = zustandMMKVBackingStorage.getString( key );
  const lastSync = zustandMMKVBackingStorage.getString( `userObservationsLastSync-v2-${userId}` );
  zustandMMKVBackingStorage.delete( key );
  zustandMMKVBackingStorage.delete( `userObservationsLastSync-v2-${userId}` );
  if ( !raw ) return;
  try {
    const tuples: [string, unknown, 0 | 1, 0 | 1, unknown, unknown, number | null][] = JSON
      .parse( raw );
    const buckets: CachedObservationTuple[][] = Array.from( { length: BUCKETS }, ( ) => [] );
    tuples.forEach( t => buckets[bucketOf( t[0] )].push( [t[0], t[2], t[3], t[6] ?? null] ) );
    buckets.forEach( ( b, i ) => store.set( bucketKey( userId, i ), JSON.stringify( b ) ) );
    if ( lastSync ) store.set( lastSyncKey( userId ), lastSync );
  } catch ( error ) {
    logger.warn( "Discarding an unreadable observation cache", error );
  }
};

// Parsing a full history is tens of thousands of entries of JSON, and every
// screen that uses the cache reads it at least twice — once to draw something
// immediately, once inside the sync. Keep each bucket's last parse, keyed by the
// exact text it came from, so a repeat read is string comparisons instead, and
// a write from anywhere (or a test clearing storage) invalidates it on its own.
const parsedBuckets = new Map<string, { raw: string; entries: CachedObservation[] }>( );

export const readUserObservationsCache = ( userId: number ): UserObservationsCache => {
  migrateV2( userId );
  const cache: UserObservationsCache = new Map( );
  for ( let i = 0; i < BUCKETS; i += 1 ) {
    const key = bucketKey( userId, i );
    const raw = store.getString( key );
    if ( raw ) {
      let parsed = parsedBuckets.get( key );
      if ( parsed?.raw !== raw ) {
        try {
          const tuples = JSON.parse( raw ) as CachedObservationTuple[];
          parsed = { raw, entries: tuples.map( fromTuple ) };
        } catch ( error ) {
          logger.warn( "Discarding an unreadable observation cache bucket", error );
          parsed = { raw, entries: [] };
        }
        parsedBuckets.set( key, parsed );
      }
      parsed.entries.forEach( entry => cache.set( entry.uuid, entry ) );
    }
  }
  return cache;
};

export const clearUserObservationsCache = ( ) => store.clearAll( );

export const readLastSync = ( userId: number ): string | null => store
  .getString( lastSyncKey( userId ) ) ?? null;

// Rewrites only the buckets holding the observations in `changed`
const writeUserObservationsCache = (
  userId: number,
  cache: UserObservationsCache,
  changed: Set<string>,
): void => {
  const dirty = new Set( [...changed].map( bucketOf ) );
  const buckets = new Map<number, CachedObservation[]>( [...dirty].map( b => [b, []] ) );
  cache.forEach( observation => buckets.get( bucketOf( observation.uuid ) )?.push( observation ) );
  buckets.forEach( ( entries, bucket ) => {
    const raw = JSON.stringify( entries.map( toTuple ) );
    store.set( bucketKey( userId, bucket ), raw );
    parsedBuckets.set( bucketKey( userId, bucket ), { raw, entries } );
  } );
};

// Applies a fave toggled in the app now, rather than at the next sync, so
// anything reading the cache (the deletion album) sees it straight away.
export const setCachedFave = (
  userId: number | undefined | null,
  uuid: string,
  faved: boolean,
) => {
  if ( !userId ) return;
  const cache = readUserObservationsCache( userId );
  const entry = cache.get( uuid );
  if ( !entry || entry.faved === faved ) return;
  cache.set( uuid, { ...entry, faved } );
  writeUserObservationsCache( userId, cache, new Set( [uuid] ) );
};

const toCachedObservation = ( observation: ApiObservation ): CachedObservation => ( {
  uuid: observation.uuid,
  faved: ( observation.votes || [] ).some( vote => vote?.vote_scope === null ),
  researchGrade: observation.quality_grade === "research",
  speciesId: speciesIdFromTaxon( observation.taxon ),
} );

// The union of what the cache stores and what callers harvest from the same
// pass, so one request serves everyone. Asking for less would only push a
// consumer back into fetching the history on its own.
export const OBSERVATION_SYNC_FIELDS = {
  id: true,
  uuid: true,
  observed_on: true,
  time_observed_at: true,
  created_at: true,
  quality_grade: true,
  votes: {
    id: true,
    user_id: true,
    vote_flag: true,
    vote_scope: true,
  },
  observation_photos: {
    photo: {
      url: true,
      license_code: true,
      attribution: true,
    },
  },
  taxon: Taxon.LIMITED_TAXON_FIELDS,
};

interface SyncOptions {
  // Called with each raw page as it arrives, for callers that need more than
  // the cache stores (My Lifers keeps the taxon and photo it renders). Runs
  // during the same pass so nothing has to be fetched twice.
  onPage?: ( results: ApiObservation[] ) => void;
  // Called with how much of the history has landed so far, for progress UI.
  onProgress?: ( syncedCount: number ) => void;
}

// Brings the cache up to date and returns it. The first run pages the whole
// history; after that only observations created or updated since the last sync
// are fetched, which is normally a single request.
//
// Paging is by `id_above` cursor rather than the `page` param. The API's page
// param only reaches the first 10,000 results (see exploreParams.ts, which
// paginates the same way for the same reason) and errors past that, so a
// history longer than that could never finish a first sync: the request threw,
// nothing was written, and the cache stayed empty on every run. Delete Unfaved
// then fell back to Realm, which holds only the most recent page of remote
// observations — which is exactly the older half of the history going missing
// from it. A cursor has no such ceiling.
//
// The last-sync timestamp is only recorded once every page has landed, so a
// request that fails partway through means the next run re-fetches rather than
// leaving a permanent hole in the cache. What did land is still written,
// though: a long history that keeps being interrupted should get closer to
// complete each time instead of starting from nothing.
export const syncUserObservations = async (
  userId: number | undefined | null,
  opts: { api_token: string | null },
  { onPage, onProgress }: SyncOptions = {},
): Promise<UserObservationsCache> => {
  if ( !userId ) {
    return new Map( );
  }
  const cache = readUserObservationsCache( userId );
  const lastSync = readLastSync( userId );
  // Recorded before fetching so anything that changes while this sync is in
  // flight is picked up by the next one rather than missed.
  const syncStartedAt = new Date( ).toISOString( );

  let pages = 0;
  let syncedCount = 0;
  let idAbove: number | undefined;
  let hasMorePages = true;
  // Observations whose cached entry this sync actually changed
  const changed = new Set<string>( );
  // Anything already merged into the cache is worth keeping even if a later
  // page never arrives, so persist it — without recording the sync, which is
  // what makes the next run re-fetch from the top.
  const savePartial = ( ) => writeUserObservationsCache( userId, cache, changed );
  while ( hasMorePages && pages < MAX_PAGES ) {
    pages += 1;
    let response;
    try {
      // Each page gets its own timeout: the caller's opts carry one signal
      // sized for a single request, and a first sync is hundreds of them, so
      // sharing it aborted every page after the first 20 seconds and the sync
      // could never finish.
      const params = {
        user_id: userId,
        order_by: "id",
        order: "asc",
        per_page: PAGE_SIZE,
        fields: OBSERVATION_SYNC_FIELDS,
        ttl: -1,
        ...( idAbove === undefined
          ? {}
          : { id_above: idAbove } ),
        ...( lastSync
          ? { updated_since: lastSync }
          : {} ),
      };
      // eslint-disable-next-line no-await-in-loop
      response = await withRequestTimeout(
        opts,
        requestOpts => searchObservations( params, requestOpts ),
      );
    } catch ( error ) {
      savePartial( );
      throw error;
    }
    // A body without a results array isn't an empty history, it's a response we
    // can't read. Bail without recording the sync so the next run retries.
    if ( !Array.isArray( response?.results ) ) {
      logger.warn( `Unreadable observation page ${pages}; keeping what has synced so far` );
      savePartial( );
      return cache;
    }
    const { results }: { results: ApiObservation[] } = response;
    results.forEach( observation => {
      const entry = toCachedObservation( observation );
      const old = cache.get( entry.uuid );
      if (
        old?.faved === entry.faved
        && old.researchGrade === entry.researchGrade
        && old.speciesId === entry.speciesId
      ) return;
      cache.set( entry.uuid, entry );
      changed.add( entry.uuid );
    } );
    onPage?.( results );
    syncedCount += results.length;
    onProgress?.( syncedCount );
    // Ordered by id ascending, so the last result is the high-water mark. A
    // page whose results carry no id can't advance the cursor, and repeating
    // the same request forever is worse than stopping short.
    const lastId = results[results.length - 1]?.id;
    hasMorePages = results.length === PAGE_SIZE && typeof lastId === "number";
    idAbove = lastId;
  }

  writeUserObservationsCache( userId, cache, changed );
  store.set( lastSyncKey( userId ), syncStartedAt );
  return cache;
};
