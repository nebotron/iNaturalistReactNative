import calculateConfidence from "components/Match/calculateConfidence";
import { TaxonResult } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";

interface GenusTaxon {
  id: number;
  name: string;
  preferred_common_name?: string;
}

interface Props {
  accessibilityLabel: string;
  genusTaxon?: GenusTaxon;
  onSelectGenus?: ( ) => void;
  onTaxonChosen: ( taxon: object ) => void;
  suggestion: {
    taxon: {
      id: number;
      name: string;
      preferred_common_name: string;
      rank: string;
      iconic_taxon_name: string;
    };
    combined_score: number;
  };
}

const Suggestion = ( {
  accessibilityLabel,
  genusTaxon,
  onSelectGenus,
  suggestion,
  onTaxonChosen,
}: Props ) => (
  <View>
    <TaxonResult
      accessibilityLabel={accessibilityLabel}
      activeColor="bg-inatGreen"
      confidencePercentage={calculateConfidence( suggestion )}
      confidencePosition="text"
      fetchRemote={false}
      first
      showCheckmark
      handleCheckmarkPress={onTaxonChosen}
      hideNavButtons
      lastScreen="Suggestions"
      onSelectGenus={genusTaxon ? onSelectGenus : undefined}
      taxon={suggestion?.taxon}
      testID={`SuggestionsList.taxa.${suggestion?.taxon?.id}`}
      vision
    />
  </View>
);

export default Suggestion;
