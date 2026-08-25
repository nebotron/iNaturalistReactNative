import { searchObservations } from "api/observations";
import type { ApiObservation, ApiTaxon } from "api/types";
import Taxon from "realmModels/Taxon";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

const logger = log.extend( "userObservationsCache" );

// One local cache of the signed-in user's observation history, shared by every
// feature that has to reason about all of it rather than the handful Realm
// keeps. My Lifers and Photo Cleanup both used to page the API themselves and
// keep a private cache, so the same history was downloaded twice and opening
// one screen did nothing for the other. Now whichever screen is opened first
// pays for the sync and the other one starts warm.
//
// Realm isn't the right home for this: it holds only the most recent page of
// remote observations plus whatever this device created, which is why Photo
// Cleanup could only ever see fave status for a sliver of the history.

// Max page size the API allows.
const PAGE_SIZE = 200;
// Safety valve so a huge history can't loop forever; 500 pages is 100k obs.
const MAX_PAGES = 500;

export interface CachedObservation {
  uuid: string;
  // Capture time floored to the whole second, or null with no usable date.
  observedAtMs: number | null;
  // Favorited by at least one user, i.e. it has a vote with a null scope.
  faved: boolean;
  researchGrade: boolean;
  taxonId: number | null;
  rankLevel: number | null;
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

// v2 added speciesId, which can't be derived from what v1 stored, so a v1
// cache has to be re-synced rather than migrated.
const cacheKey = ( userId: number ) => `userObservations-v2-${userId}`;
const lastSyncKey = ( userId: number ) => `userObservationsLastSync-v2-${userId}`;

// Stored as positional tuples rather than objects: a full history is tens of
// thousands of entries, and the key names would be most of the payload.
type CachedObservationTuple = [
  string,
  number | null,
  0 | 1,
  0 | 1,
  number | null,
  number | null,
  number | null,
];

const toTuple = ( observation: CachedObservation ): CachedObservationTuple => [
  observation.uuid,
  observation.observedAtMs,
  observation.faved
    ? 1
    : 0,
  observation.researchGrade
    ? 1
    : 0,
  observation.taxonId,
  observation.rankLevel,
  observation.speciesId,
];

const fromTuple = ( tuple: CachedObservationTuple ): CachedObservation => ( {
  uuid: tuple[0],
  observedAtMs: tuple[1],
  faved: tuple[2] === 1,
  researchGrade: tuple[3] === 1,
  taxonId: tuple[4],
  rankLevel: tuple[5],
  speciesId: tuple[6] ?? null,
} );

// Parsing a full history is tens of thousands of entries of JSON, and every
// screen that uses the cache reads it at least twice — once to draw something
// immediately, once inside the sync. Keep the last parse, keyed by the exact
// text it came from, so a repeat read is a string comparison instead. Keying on
// the text rather than the user means a write from anywhere (or a test clearing
// storage) invalidates it on its own.
let parsedCache: { key: string; raw: string; cache: UserObservationsCache } | null = null;

export const readUserObservationsCache = ( userId: number ): UserObservationsCache => {
  const key = cacheKey( userId );
  const raw = zustandStorage.getItem( key );
  if ( typeof raw !== "string" ) {
    return new Map( );
  }
  if ( parsedCache?.key === key && parsedCache.raw === raw ) {
    return parsedCache.cache;
  }
  try {
    const tuples: CachedObservationTuple[] = JSON.parse( raw );
    const cache = new Map( tuples.map( tuple => [tuple[0], fromTuple( tuple )] ) );
    parsedCache = { key, raw, cache };
    return cache;
  } catch ( error ) {
    logger.warn( "Discarding an unreadable observation cache", error );
    return new Map( );
  }
};

export const readLastSync = ( userId: number ): string | null => {
  const lastSync = zustandStorage.getItem( lastSyncKey( userId ) );
  return typeof lastSync === "string"
    ? lastSync
    : null;
};

const writeUserObservationsCache = (
  userId: number,
  cache: UserObservationsCache,
): void => {
  const raw = JSON.stringify( Array.from( cache.values( ) ).map( toTuple ) );
  const key = cacheKey( userId );
  zustandStorage.setItem( key, raw );
  // The v1 cache, which nothing reads now. A full history is megabytes, so it's
  // worth reclaiming rather than leaving on disk.
  zustandStorage.removeItem( `userObservations-v1-${userId}` );
  zustandStorage.removeItem( `userObservationsLastSync-v1-${userId}` );
  parsedCache = { key, raw, cache };
};

const toWholeSecondMs = ( ms: number ): number => Math.floor( ms / 1000 ) * 1000;

const observedAtMsFromApi = ( observation: ApiObservation ): number | null => {
  const raw = observation.time_observed_at
    || observation.observed_on
    || observation.created_at;
  if ( !raw ) {
    return null;
  }
  const time = new Date( raw ).getTime( );
  return Number.isNaN( time )
    ? null
    : toWholeSecondMs( time );
};

const toCachedObservation = ( observation: ApiObservation ): CachedObservation => ( {
  uuid: observation.uuid,
  observedAtMs: observedAtMsFromApi( observation ),
  faved: ( observation.votes || [] ).some( vote => vote?.vote_scope === null ),
  researchGrade: observation.quality_grade === "research",
  taxonId: observation.taxon?.id ?? null,
  rankLevel: observation.taxon?.rank_level ?? null,
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
  // Anything already merged into the cache is worth keeping even if a later
  // page never arrives, so persist it — without recording the sync, which is
  // what makes the next run re-fetch from the top.
  const savePartial = ( ) => {
    if ( syncedCount > 0 ) {
      writeUserObservationsCache( userId, cache );
    }
  };
  while ( hasMorePages && pages < MAX_PAGES ) {
    pages += 1;
    let response;
    try {
      // eslint-disable-next-line no-await-in-loop
      response = await searchObservations( {
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
      }, opts );
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
      cache.set( observation.uuid, toCachedObservation( observation ) );
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

  if ( syncedCount === 0 && cache.size > 0 ) {
    // Nothing changed, and re-serializing an entire history to store exactly
    // what's already there is the slowest part of an up-to-date sync.
    zustandStorage.setItem( lastSyncKey( userId ), syncStartedAt );
    return cache;
  }
  writeUserObservationsCache( userId, cache );
  zustandStorage.setItem( lastSyncKey( userId ), syncStartedAt );
  return cache;
};
