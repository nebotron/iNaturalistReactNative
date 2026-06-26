import { zustandStorage } from "stores/useStore";

const STATS_KEY = "speciesGameStats";
const LOOKALIKES_CACHE_KEY = "speciesGameLookalikes";
const LOOKALIKES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface LookalikeCacheEntry {
  taxonId: number;
  count: number;
  observationUuids: string[];
}

interface LookalikesCacheRecord {
  topId: number | null;
  entries: LookalikeCacheEntry[];
  cachedAt: number;
}

type LookalikesCache = Record<string, LookalikesCacheRecord>;

const loadLookalikesCache = ( ): LookalikesCache => {
  const raw = zustandStorage.getItem( LOOKALIKES_CACHE_KEY );
  if ( !raw || typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as LookalikesCache;
  } catch {
    return {};
  }
};

export const getCachedLookalikes = (
  taxonId: number,
): { topId: number | null; entries: LookalikeCacheEntry[] } | null => {
  const cache = loadLookalikesCache( );
  const record = cache[String( taxonId )];
  if ( !record ) return null;
  if ( Date.now( ) - record.cachedAt > LOOKALIKES_TTL_MS ) return null;
  return { topId: record.topId, entries: record.entries };
};

export const setCachedLookalikes = (
  taxonId: number,
  topId: number | null,
  entries: LookalikeCacheEntry[],
): void => {
  const cache = loadLookalikesCache( );
  cache[String( taxonId )] = { topId, entries, cachedAt: Date.now( ) };
  zustandStorage.setItem( LOOKALIKES_CACHE_KEY, JSON.stringify( cache ) );
};

export interface TaxonStats {
  correct: number;
  total: number;
}

type AllStats = Record<string, TaxonStats>;

const load = ( ): AllStats => {
  const raw = zustandStorage.getItem( STATS_KEY );
  if ( !raw || typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw ) as AllStats;
  } catch {
    return {};
  }
};

export const recordGuess = ( taxonId: number, correct: boolean ): void => {
  const stats = load( );
  const key = String( taxonId );
  const prev = stats[key] ?? { correct: 0, total: 0 };
  stats[key] = {
    correct: prev.correct + ( correct ? 1 : 0 ),
    total: prev.total + 1,
  };
  zustandStorage.setItem( STATS_KEY, JSON.stringify( stats ) );
};

export const getStats = ( taxonId: number ): TaxonStats | null => {
  const stats = load( );
  return stats[String( taxonId )] ?? null;
};
