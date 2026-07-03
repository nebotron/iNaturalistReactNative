import calculateConfidence from "components/Match/calculateConfidence";
import { TaxonResult } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";

interface Props {
  accessibilityLabel: string;
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
  onSelectGenus,
  suggestion,
  onTaxonChosen,
}: Props ) => (
  <View testID={`Suggestion.${suggestion?.taxon?.id}`}>
    <TaxonResult
      accessibilityLabel={accessibilityLabel}
      activeColor="bg-inatGreen"
      confidencePercentage={calculateConfidence( suggestion )}
      confidencePosition="text"
      fetchRemote={false}
      first
      hideInfoButton
      showCheckmark
      handleCheckmarkPress={onTaxonChosen}
      hideNavButtons
      lastScreen="Suggestions"
      onSelectGenus={onSelectGenus}
      taxon={suggestion?.taxon}
      testID={`SuggestionsList.taxa.${suggestion?.taxon?.id}`}
      vision
    />
  </View>
);

export default Suggestion;
