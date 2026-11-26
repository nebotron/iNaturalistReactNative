// Merges the excluded species (see excludedSpecies) into without_taxon_id, which
// also leaves out each species' descendants. Returns the existing value when
// there's nothing to add.
const withoutObservedSpecies = (
  existing: number | string | number[] | undefined,
  speciesIds: number[],
): number | string | number[] | undefined => {
  if ( speciesIds.length === 0 ) return existing;
  // taxonFiltersToApiParams can leave without_taxon_id as a single number or
  // a comma-joined string rather than an array, so normalize before merging.
  let existingIds: number[] = [];
  if ( Array.isArray( existing ) ) {
    existingIds = existing;
  } else if ( existing || existing === 0 ) {
    existingIds = String( existing ).split( "," ).map( Number );
  }
  return Array.from( new Set( [...existingIds, ...speciesIds] ) ).join( "," );
};

export default withoutObservedSpecies;
