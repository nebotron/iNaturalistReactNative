import { readUserObservationsCache } from "sharedHelpers/userObservationsCache";

// The API's unobserved_by_user_id filter only excludes taxa the user has
// observed at that exact rank, so a subspecies whose parent species the user
// has already observed at research grade still shows up as "unobserved".
// Exclude those species too (and, via without_taxon_id, their descendants)
// using the observation history already cached locally for My Lifers,
// rather than making another request. Returns the merged without_taxon_id,
// or the existing value when there's nothing to add.
const withoutObservedSpecies = (
  existing: number | string | number[] | undefined,
  userId: number,
): number | string | number[] | undefined => {
  const ids = new Set<number>( );
  readUserObservationsCache( userId ).forEach( observation => {
    // speciesId, not taxonId: an observation identified below species level
    // is still an observation of the species, and excluding the species
    // excludes its descendants too.
    if ( observation.researchGrade && observation.speciesId ) {
      ids.add( observation.speciesId );
    }
  } );
  if ( ids.size === 0 ) return existing;
  // taxonFiltersToApiParams can leave without_taxon_id as a single number or
  // a comma-joined string rather than an array, so normalize before merging.
  let existingIds: number[] = [];
  if ( Array.isArray( existing ) ) {
    existingIds = existing;
  } else if ( existing || existing === 0 ) {
    existingIds = String( existing ).split( "," ).map( Number );
  }
  return Array.from( new Set( [...existingIds, ...ids] ) ).join( "," );
};

export default withoutObservedSpecies;
