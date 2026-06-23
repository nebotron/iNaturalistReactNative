import calculateConfidence from "components/Match/calculateConfidence";
import {
  Body3,
  TaxonResult,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

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
}: Props ) => {
  const { t } = useTranslation( );
  return (
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
        taxon={suggestion?.taxon}
        testID={`SuggestionsList.taxa.${suggestion?.taxon?.id}`}
        vision
      />
      {genusTaxon && onSelectGenus && (
        <Pressable
          onPress={onSelectGenus}
          className="ml-[82px] -mt-2 mb-2 flex-row items-center"
          testID={`SuggestionsList.genus.${genusTaxon.id}`}
          accessibilityRole="button"
          accessibilityLabel={t( "SUGGEST-GENUS" )}
        >
          <Body3 className="color-inatGreen">
            {genusTaxon.preferred_common_name
              ? `${genusTaxon.preferred_common_name} (${genusTaxon.name})`
              : genusTaxon.name}
          </Body3>
        </Pressable>
      )}
    </View>
  );
};

export default Suggestion;
