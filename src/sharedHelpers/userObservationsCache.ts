import { searchObservations } from "api/observations";
import type { ApiObservation } from "api/types";
import Taxon from "realmModels/Taxon";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";

const logger = log.extend( "userObservationsCache" );

// One local cache of the signed-in user's observation history, shared by every
// feature that has to reason about all of it rather than the handful Realm
// keeps. My Lifers and Delete Unfaved both used to page the API themselves and
// keep a private cache, so the same history was downloaded twice and opening
// one screen did nothing for the other. Now whichever screen is opened first
// pays for the sync and the other one starts warm.
//
// Realm isn't the right home for this: it holds only the most recent page of
// remote observations plus whatever this device created, which is why Delete
// Unfaved could only ever see fave status for a sliver of the history.

// Max page size the API allows.
const PAGE_SIZE = 200;
// Safety valve so a huge history can't loop forever; 250 pages is 50k obs.
const MAX_PAGES = 250;

export interface CachedObservation {
  uuid: string;
  // Capture time floored to the whole second, or null with no usable date.
  observedAtMs: number | null;
  // Favorited by at least one user, i.e. it has a vote with a null scope.
  faved: boolean;
  researchGrade: boolean;
  taxonId: number | null;
  rankLevel: number | null;
}

export type UserObservationsCache = Map<string, CachedObservation>;

const cacheKey = ( userId: number ) => `userObservations-v1-${userId}`;
const lastSyncKey = ( userId: number ) => `userObservationsLastSync-v1-${userId}`;

// Stored as positional tuples rather than objects: a full history is tens of
// thousands of entries, and the key names would be most of the payload.
type CachedObservationTuple = [
  string,
  number | null,
  0 | 1,
  0 | 1,
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
];

const fromTuple = ( tuple: CachedObservationTuple ): CachedObservation => ( {
  uuid: tuple[0],
  observedAtMs: tuple[1],
  faved: tuple[2] === 1,
  researchGrade: tuple[3] === 1,
  taxonId: tuple[4],
  rankLevel: tuple[5],
} );

export const readUserObservationsCache = ( userId: number ): UserObservationsCache => {
  const raw = zustandStorage.getItem( cacheKey( userId ) );
  if ( typeof raw !== "string" ) {
    return new Map( );
  }
  try {
    const tuples: CachedObservationTuple[] = JSON.parse( raw );
    return new Map( tuples.map( tuple => [tuple[0], fromTuple( tuple )] ) );
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
  lastSync: string,
): void => {
  zustandStorage.setItem(
    cacheKey( userId ),
    JSON.stringify( Array.from( cache.values( ) ).map( toTuple ) ),
  );
  zustandStorage.setItem( lastSyncKey( userId ), lastSync );
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
// The last-sync timestamp is only recorded once every page has landed, so a
// request that fails partway through means the next run re-fetches rather than
// leaving a permanent hole in the cache.
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

  let page = 1;
  let syncedCount = 0;
  let hasMorePages = true;
  while ( hasMorePages && page <= MAX_PAGES ) {
    // eslint-disable-next-line no-await-in-loop
    const response = await searchObservations( {
      user_id: userId,
      order_by: "id",
      order: "asc",
      per_page: PAGE_SIZE,
      fields: OBSERVATION_SYNC_FIELDS,
      ttl: -1,
      page,
      ...( lastSync
        ? { updated_since: lastSync }
        : {} ),
    }, opts );
    // A body without a results array isn't an empty history, it's a response we
    // can't read. Bail without recording the sync so the next run retries.
    if ( !Array.isArray( response?.results ) ) {
      logger.warn( `Unreadable observation page ${page}; leaving the cache as it was` );
      return cache;
    }
    const { results }: { results: ApiObservation[] } = response;
    results.forEach( observation => {
      cache.set( observation.uuid, toCachedObservation( observation ) );
    } );
    onPage?.( results );
    syncedCount += results.length;
    onProgress?.( syncedCount );
    hasMorePages = results.length === PAGE_SIZE;
    page += 1;
  }

  writeUserObservationsCache( userId, cache, syncStartedAt );
  return cache;
};
