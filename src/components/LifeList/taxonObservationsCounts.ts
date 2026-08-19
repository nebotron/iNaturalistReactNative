import { fetchTaxaObservationsCounts } from "api/taxa";
import type { ApiTaxon } from "api/types";
import { zustandStorage } from "stores/useStore";

// Max number of taxon ids the /v1/taxa batch endpoint accepts per request
const TAXA_BATCH_SIZE = 30;

// How long a global observation count is good for. These move slowly relative
// to how rare a species is, so a month keeps the list feeling right without
// re-fetching every species on every visit.
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

const CACHE_KEY = "taxonObservationsCounts-v1";

interface CountEntry {
  count: number;
  fetchedAtMs: number;
}

type CountCache = Record<string, CountEntry>;

function readCache( ): CountCache {
  const raw = zustandStorage.getItem( CACHE_KEY );
  if ( typeof raw !== "string" ) return {};
  try {
    return JSON.parse( raw );
  } catch {
    return {};
  }
}

function writeCache( cache: CountCache ): void {
  zustandStorage.setItem( CACHE_KEY, JSON.stringify( cache ) );
}

// The counts we already have, for rendering and sorting before any fetch.
export function readTaxonObservationsCounts( ): Record<number, number> {
  const cache = readCache( );
  const counts: Record<number, number> = {};
  Object.entries( cache ).forEach( ( [taxonId, entry] ) => {
    counts[Number( taxonId )] = entry.count;
  } );
  return counts;
}

// Fetches the counts we're missing or that have gone stale, and prunes the
// cache to the taxa asked for, so it tracks the user's species rather than
// growing with every taxon ever looked at.
export async function syncTaxonObservationsCounts(
  taxonIds: number[],
  opts: { api_token: string | null },
): Promise<Record<number, number>> {
  const cache = readCache( );
  const now = Date.now( );
  const needed = taxonIds.filter( taxonId => {
    const entry = cache[taxonId];
    return !entry || now - entry.fetchedAtMs > STALE_MS;
  } );

  for ( let i = 0; i < needed.length; i += TAXA_BATCH_SIZE ) {
    const batch = needed.slice( i, i + TAXA_BATCH_SIZE );
    // eslint-disable-next-line no-await-in-loop
    const results = await fetchTaxaObservationsCounts( batch, opts );
    ( ( results as ApiTaxon[] ) ?? [] ).forEach( taxon => {
      if ( typeof taxon.id !== "number" || typeof taxon.observations_count !== "number" ) return;
      cache[taxon.id] = { count: taxon.observations_count, fetchedAtMs: now };
    } );
  }

  const pruned: CountCache = {};
  const counts: Record<number, number> = {};
  taxonIds.forEach( taxonId => {
    const entry = cache[taxonId];
    if ( entry ) {
      pruned[taxonId] = entry;
      counts[taxonId] = entry.count;
    }
  } );
  writeCache( pruned );

  return counts;
}
