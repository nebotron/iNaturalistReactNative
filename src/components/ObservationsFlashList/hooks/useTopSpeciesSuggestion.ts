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
  observation?: { id?: number; taxon?: { rank_level?: number } },
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

  // Pick the highest-scoring result that is species-level or finer (e.g. a
  // subspecies), so a genus-or-broader observation gets bumped to the CV's
  // most likely species. Results usually arrive score-sorted, but sort
  // defensively so "most likely" doesn't depend on server ordering.
  const results = isGenusOrBroader
    ? ( data as { results?: CVResult[] } )?.results ?? []
    : [];
  const topSpecies = results
    .filter( result => typeof result.taxon?.rank_level === "number"
      && result.taxon.rank_level <= Taxon.SPECIES_LEVEL )
    .sort( ( a, b ) => ( b.combined_score ?? 0 ) - ( a.combined_score ?? 0 ) )[0];
  return topSpecies?.taxon;
};

export default useTopSpeciesSuggestion;
