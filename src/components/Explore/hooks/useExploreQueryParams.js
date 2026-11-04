// @flow

import mapParamsToAPI from "components/Explore/helpers/mapParamsToAPI";
import withoutObservedSpecies from "components/Explore/helpers/withoutObservedSpecies";
import { useMemo } from "react";

const useExploreQueryParams = ( state: Object, currentUser: ?Object ): Object => useMemo( ( ) => {
  const filteredParams = mapParamsToAPI( state, currentUser );
  if ( currentUser && state.unobservedByMe ) {
    const withoutTaxonId = withoutObservedSpecies(
      filteredParams.without_taxon_id,
      currentUser.id,
    );
    if ( withoutTaxonId !== undefined ) filteredParams.without_taxon_id = withoutTaxonId;
  }
  return filteredParams;
}, [state, currentUser] );

export default useExploreQueryParams;
