import { zustandStorage } from "stores/useStore";

const STATS_KEY = "speciesGameStats";
const USED_UUIDS_KEY = "speciesGameUsedUuids";

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
    correct: prev.correct + ( correct
      ? 1
      : 0 ),
    total: prev.total + 1,
  };
  zustandStorage.setItem( STATS_KEY, JSON.stringify( stats ) );
};

export const getStats = ( taxonId: number ): TaxonStats | null => {
  const stats = load( );
  return stats[String( taxonId )] ?? null;
};

const loadUsedUuids = ( taxonId: number ): string[] => {
  const raw = zustandStorage.getItem( `${USED_UUIDS_KEY}_${taxonId}` );
  if ( !raw || typeof raw !== "string" ) return [];
  try {
    return JSON.parse( raw ) as string[];
  } catch {
    return [];
  }
};

export const getUsedUuids = ( taxonId: number ): Set<string> => new Set( loadUsedUuids( taxonId ) );

export const addUsedUuid = ( taxonId: number, uuid: string, currentSet: Set<string> ): void => {
  currentSet.add( uuid );
  zustandStorage.setItem( `${USED_UUIDS_KEY}_${taxonId}`, JSON.stringify( [...currentSet] ) );
};
