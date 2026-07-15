import { scoreObservation } from "api/computerVision";
import Taxon from "realmModels/Taxon";
import { useAuthenticatedQuery, useCurrentUser } from "sharedHooks";

interface RankedTaxon {
  id?: number;
  rank?: string;
  rank_level?: number;
}

interface CVResult {
  combined_score?: number;
  taxon?: RankedTaxon;
}

// API taxa reliably carry a `rank` string but not always a numeric
// `rank_level`, so map ranks to levels to fall back on. Mirrors the mapping in
// sharedHelpers/offlineTaxonomy.
const RANK_LEVEL_BY_RANK: Record<string, number> = {
  stateofmatter: 100,
  kingdom: 70,
  phylum: 60,
  subphylum: 57,
  superclass: 53,
  class: 50,
  subclass: 47,
  infraclass: 45,
  subterclass: 44,
  superorder: 43,
  order: 40,
  suborder: 37,
  infraorder: 35,
  zoosection: 34,
  superfamily: 33,
  epifamily: 32,
  family: 30,
  subfamily: 27,
  supertribe: 26,
  tribe: 25,
  subtribe: 24,
  genus: 20,
  subgenus: 15,
  section: 13,
  subsection: 12,
  complex: 11,
  species: 10,
  subspecies: 5,
};

const rankLevelForTaxon = ( taxon?: RankedTaxon ): number | undefined => {
  if ( typeof taxon?.rank_level === "number" ) return taxon.rank_level;
  return taxon?.rank
    ? RANK_LEVEL_BY_RANK[taxon.rank]
    : undefined;
};

// If an observation's community taxon is genus or broader, look up the most
// likely species-level ID from the CV algorithm so we can suggest agreeing
// with a species instead of the coarser community taxon.
const useTopSpeciesSuggestion = (
  observation?: { id?: number; taxon?: RankedTaxon },
  enabled: boolean = true,
) => {
  const currentUser = useCurrentUser( );
  const communityRankLevel = rankLevelForTaxon( observation?.taxon );
  const isGenusOrBroader = communityRankLevel != null
    && communityRankLevel >= Taxon.GENUS_LEVEL;

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
    .filter( result => {
      const rankLevel = rankLevelForTaxon( result.taxon );
      return rankLevel != null && rankLevel <= Taxon.SPECIES_LEVEL;
    } )
    .sort( ( a, b ) => ( b.combined_score ?? 0 ) - ( a.combined_score ?? 0 ) )[0];
  return topSpecies?.taxon;
};

export default useTopSpeciesSuggestion;
