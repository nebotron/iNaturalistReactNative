import { log } from "sharedHelpers/logger";
import type { UserObservationsCache } from "sharedHelpers/userObservationsCache";
import {
  readUserObservationsCache,
  syncUserObservations,
} from "sharedHelpers/userObservationsCache";

const logger = log.extend( "withoutObservedSpecies" );

// "Unobserved by me" hides every species the user has a research-grade
// observation of, and with it, via without_taxon_id, all of that species'
// descendants. It deliberately doesn't use the API's unobserved_by_user_id: that
// counts observations of any quality grade and only at the exact rank
// observed, so a subspecies of a species the user has seen still showed up.
//
// The species come from the user's whole observation history, synced locally
// (the same cache My Lifers uses). It's synced first so a species observed
// since the last sync is hidden too; offline, or if the sync fails, the
// previous list is used.
export const researchGradeSpeciesIds = ( cache: UserObservationsCache ): number[] => {
  const ids = new Set<number>( );
  cache.forEach( observation => {
    // speciesId, not taxonId: an observation identified below species level
    // is still an observation of the species.
    if ( observation.researchGrade && observation.speciesId ) {
      ids.add( observation.speciesId );
    }
  } );
  return Array.from( ids );
};

export const syncResearchGradeSpeciesIds = async (
  userId: number,
  opts: { api_token: string | null },
  { offline = false } = {},
): Promise<number[]> => {
  if ( !offline ) {
    try {
      return researchGradeSpeciesIds( await syncUserObservations( userId, opts ) );
    } catch ( error ) {
      logger.warn( "Couldn't sync observed species; using the previous list", error );
    }
  }
  return researchGradeSpeciesIds( readUserObservationsCache( userId ) );
};

// Merges the observed species into without_taxon_id. Returns the existing value
// when there's nothing to add.
const withoutObservedSpecies = (
  existing: number | string | number[] | undefined,
  observedSpeciesIds: number[],
): number | string | number[] | undefined => {
  if ( observedSpeciesIds.length === 0 ) return existing;
  // taxonFiltersToApiParams can leave without_taxon_id as a single number or
  // a comma-joined string rather than an array, so normalize before merging.
  let existingIds: number[] = [];
  if ( Array.isArray( existing ) ) {
    existingIds = existing;
  } else if ( existing || existing === 0 ) {
    existingIds = String( existing ).split( "," ).map( Number );
  }
  return Array.from( new Set( [...existingIds, ...observedSpeciesIds] ) ).join( "," );
};

export default withoutObservedSpecies;
