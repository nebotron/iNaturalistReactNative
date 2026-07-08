import { zustandStorage } from "stores/useStore";

export const INATURALIST_API = "https://api.inaturalist.org/v1";
export const LOOKALIKE_CACHE_KEY = "speciesGameLookalikes";
export const LOOKALIKE_RADIUS_KM = 500;
export const LOOKALIKE_PAGE_SIZE = 200;
export const FETCH_MORE_OBS_COUNT = 400;

export interface LookalikeCacheEntry {
  entries: { taxonId: number; count: number; observationUuids: string[] }[];
  topId: number | null;
  obsScanned: number;
}

export interface LookalikeEntry {
  taxonId: number;
  name: string;
  commonName?: string;
  count: number;
  observationUuids: string[];
}

export function computeLookalikesFromObs(
  results: unknown[],
  targetId: number,
  seed?: { taxonId: number; count: number; observationUuids: string[] }[],
): { topId: number | null; entries: { taxonId: number; count: number; observationUuids: string[] }[] } {
  const counts: Record<number, { count: number; observationUuids: string[] }> = {};
  for ( const s of seed ?? [] ) {
    counts[s.taxonId] = { count: s.count, observationUuids: [...s.observationUuids] };
  }
  for ( const obs of results ) {
    for ( const ident of ( obs as { identifications?: unknown[] } ).identifications ?? [] ) {
      const altId: number | undefined = ( ident as { taxon?: { id?: number } } ).taxon?.id;
      const rankLevel: number | undefined
        = ( ident as { taxon?: { rank_level?: number } } ).taxon?.rank_level;
      if ( altId && altId !== targetId && rankLevel === 10 ) {
        if ( !counts[altId] ) counts[altId] = { count: 0, observationUuids: [] };
        counts[altId].count += 1;
        const uuid = ( obs as { uuid?: string } ).uuid;
        if ( uuid && !counts[altId].observationUuids.includes( uuid ) ) {
          counts[altId].observationUuids.push( uuid );
        }
      }
    }
  }
  const entries = Object.entries( counts )
    .map( ( [id, d] ) => ( {
      taxonId: Number( id ),
      count: d.count,
      observationUuids: d.observationUuids,
    } ) )
    .sort( ( a, b ) => b.count - a.count );
  return { topId: entries.length > 0 ? entries[0].taxonId : null, entries };
}

export function getCachedLookalikes( taxonId: number ): LookalikeCacheEntry | null {
  const raw = zustandStorage.getItem( `${LOOKALIKE_CACHE_KEY}_${taxonId}` );
  if ( !raw || typeof raw !== "string" ) return null;
  try {
    return JSON.parse( raw ) as LookalikeCacheEntry;
  } catch {
    return null;
  }
}

export function setCachedLookalikes( taxonId: number, value: LookalikeCacheEntry ): void {
  zustandStorage.setItem( `${LOOKALIKE_CACHE_KEY}_${taxonId}`, JSON.stringify( value ) );
}
