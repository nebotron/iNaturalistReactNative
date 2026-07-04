import { scoreObservation } from "api/computerVision";
import Taxon from "realmModels/Taxon";
import { useAuthenticatedQuery, useCurrentUser } from "sharedHooks";

interface CVResult {
  combined_score: number;
  taxon?: { id: number; rank_level: number };
}

// If an observation's community taxon is genus or broader, look up the most
// likely species-level ID from the CV algorithm so we can suggest agreeing
// with a species instead of the coarser community taxon.
const useTopSpeciesSuggestion = (
  observation?: { id?: number, taxon?: { rank_level?: number } },
  enabled: boolean = true,
) => {
  const currentUser = useCurrentUser( );
  const communityTaxon = observation?.taxon;
  const isGenusOrBroader = !!communityTaxon
    && typeof communityTaxon.rank_level === "number"
    && communityTaxon.rank_level >= Taxon.GENUS_LEVEL;

  const { data } = useAuthenticatedQuery(
    ["useTopSpeciesSuggestion", observation?.id],
    optsWithAuth => scoreObservation( { id: observation?.id as number }, optsWithAuth ),
    {
      enabled: enabled && isGenusOrBroader && !!currentUser && !!observation?.id,
      staleTime: Infinity,
    },
  );

  if ( !isGenusOrBroader ) {
    return undefined;
  }

  const results = ( data as { results?: CVResult[] } )?.results;
  const topSpeciesResult = results?.find(
    result => result.taxon?.rank_level === Taxon.SPECIES_LEVEL,
  );
  return topSpeciesResult?.taxon;
};

export default useTopSpeciesSuggestion;
