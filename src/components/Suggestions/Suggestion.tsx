import calculateConfidence from "components/Match/calculateConfidence";
import { TaxonResult } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";

interface Props {
  accessibilityHint: string;
  fetchRemote?: boolean;
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
  accessibilityHint,
  fetchRemote = false,
  onSelectGenus,
  suggestion,
  onTaxonChosen,
}: Props ) => (
  <View testID={`Suggestion.${suggestion?.taxon?.id}`}>
    <TaxonResult
      accessibilityHint={accessibilityHint}
      activeColor="bg-inatGreen"
      confidencePercentage={calculateConfidence( suggestion )}
      confidencePosition="text"
      fetchRemote={fetchRemote}
      first
      handleTaxonOrEditPress={onTaxonChosen}
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
