import { fetchTaxon } from "api/taxa";
import { RealmContext } from "providers/contexts";
import { useCallback, useMemo } from "react";
import TaxonModel from "realmModels/Taxon";
import fetchTaxonAndSave from "sharedHelpers/fetchTaxonAndSave";
import { getAncestorsFromTaxonomyFile } from "sharedHelpers/offlineTaxonomy";

const { useRealm } = RealmContext;

interface GenusSuggestion {
  taxon: { id: number; rank_level?: number; ancestor_ids?: number[] };
}

// The "suggest genus" button for suggestions at species level or finer
const useSelectGenus = (
  suggestions: {
    topSuggestion?: GenusSuggestion | null;
    otherSuggestions?: GenusSuggestion[];
  },
  navigateWithTaxonSelected: ( taxon: unknown ) => void,
) => {
  const realm = useRealm( );

  // Taxa ranked at species level or finer (or of unknown rank) can show a
  // "suggest genus" button; this is decided synchronously from data already
  // in Realm so the button appears immediately instead of after a lookup.
  const genusEligibleTaxonIds = useMemo( ( ) => {
    const allSuggestions = [
      ...( suggestions.topSuggestion
        ? [suggestions.topSuggestion]
        : [] ),
      ...( suggestions.otherSuggestions || [] ),
    ];
    const eligibleIds = new Set<number>( );
    allSuggestions.forEach( suggestion => {
      const taxonId = suggestion.taxon.id;
      const realmTaxon = realm.objectForPrimaryKey( "Taxon", taxonId );
      const rankLevel = suggestion.taxon.rank_level ?? realmTaxon?.rank_level;
      if ( rankLevel == null || rankLevel <= TaxonModel.SPECIES_LEVEL ) {
        eligibleIds.add( taxonId );
      }
    } );
    return eligibleIds;
  }, [suggestions, realm] );

  // The actual genus taxon is only looked up once the user taps the button
  const findGenusForSuggestion = useCallback( async ( suggestion: GenusSuggestion ) => {
    const taxonId = suggestion.taxon.id;
    const realmTaxon = realm.objectForPrimaryKey( "Taxon", taxonId );
    // Offline suggestions carry ancestry from the model, so the genus can be
    // found without a network request even when the taxon isn't in Realm
    const ancestorIds = Array.from(
      realmTaxon?.ancestor_ids?.length
        ? realmTaxon.ancestor_ids
        : suggestion.taxon.ancestor_ids || [],
    );
    let offlineGenus = null;
    let foundGenusId: number | null = null;

    if ( ancestorIds.length > 0 ) {
      const genusFromRealm = realm.objects( "Taxon" ).filtered(
        "id IN $0 AND rank_level == $1",
        ancestorIds,
        TaxonModel.GENUS_LEVEL,
      )[0];
      if ( genusFromRealm ) foundGenusId = genusFromRealm.id;
    }

    if ( !foundGenusId && ancestorIds.length > 0 ) {
      try {
        const offlineAncestors = await getAncestorsFromTaxonomyFile( ancestorIds );
        const genusAncestor = offlineAncestors.find(
          a => a.rank_level === TaxonModel.GENUS_LEVEL,
        );
        offlineGenus = genusAncestor || null;
        foundGenusId = genusAncestor?.id ?? null;
      } catch { /* Taxonomy file unavailable */ }
    }

    if ( !foundGenusId ) {
      try {
        const taxonWithAncestors = await fetchTaxon( taxonId );
        const genusAncestor = taxonWithAncestors?.ancestors?.find(
          ( a: { rank_level?: number } ) => a.rank_level === TaxonModel.GENUS_LEVEL,
        );
        foundGenusId = genusAncestor?.id ?? null;
      } catch { /* API unavailable */ }
    }

    if ( !foundGenusId ) return null;

    let fullGenusTaxon = realm.objectForPrimaryKey( "Taxon", foundGenusId );
    if ( !fullGenusTaxon ) {
      try {
        fullGenusTaxon = await fetchTaxonAndSave( foundGenusId, realm );
      } catch { /* API unavailable */ }
    }

    return fullGenusTaxon || offlineGenus;
  }, [realm] );

  const handleSelectGenus = useCallback( async ( suggestion: GenusSuggestion ) => {
    const genusTaxon = await findGenusForSuggestion( suggestion );
    if ( genusTaxon ) {
      navigateWithTaxonSelected( genusTaxon );
    }
  }, [findGenusForSuggestion, navigateWithTaxonSelected] );

  return { genusEligibleTaxonIds, handleSelectGenus };
};

export default useSelectGenus;
