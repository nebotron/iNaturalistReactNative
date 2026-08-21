// @flow

import mapParamsToAPI from "components/Explore/helpers/mapParamsToAPI";
import { useMemo } from "react";
import Taxon from "realmModels/Taxon";
import { readUserObservationsCache } from "sharedHelpers/userObservationsCache";

// The API's unobserved_by_user_id filter only excludes taxa the user has
// observed at that exact rank, so a subspecies whose parent species the user
// has already observed at research grade still shows up as "unobserved".
// Exclude those species too (and, via without_taxon_id, their descendants)
// using the observation history already cached locally for My Lifers,
// rather than making another request.
const useExploreQueryParams = ( state: Object, currentUser: ?Object ): Object => {
  const observedSpeciesIds = useMemo( ( ) => {
    if ( !currentUser || !state.unobservedByMe ) return [];
    const ids = new Set( );
    readUserObservationsCache( currentUser.id ).forEach( observation => {
      if (
        observation.researchGrade
        && observation.taxonId
        && observation.rankLevel === Taxon.SPECIES_LEVEL
      ) {
        ids.add( observation.taxonId );
      }
    } );
    return Array.from( ids );
  }, [currentUser, state.unobservedByMe] );

  const filteredParams = mapParamsToAPI( state, currentUser );

  if ( observedSpeciesIds.length > 0 ) {
    // taxonFiltersToApiParams can leave without_taxon_id as a single number or
    // a comma-joined string rather than an array, so normalize before merging.
    const existingWithoutTaxonId = filteredParams.without_taxon_id;
    let existingIds = [];
    if ( Array.isArray( existingWithoutTaxonId ) ) {
      existingIds = existingWithoutTaxonId;
    } else if ( existingWithoutTaxonId || existingWithoutTaxonId === 0 ) {
      existingIds = String( existingWithoutTaxonId ).split( "," ).map( Number );
    }
    filteredParams.without_taxon_id = Array.from(
      new Set( [...existingIds, ...observedSpeciesIds] ),
    );
  }

  return filteredParams;
};

export default useExploreQueryParams;
