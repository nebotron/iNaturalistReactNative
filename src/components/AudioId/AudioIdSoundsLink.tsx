/* eslint-disable i18next/no-literal-string */
import type { ApiTaxon } from "api/types";
import { Body2 } from "components/SharedComponents";
import { MEDIA } from "providers/ExploreContext";
import React, { useCallback } from "react";
import { OBSERVATIONS_SORT } from "sharedHelpers/observationsSort";
import useNavigateToExplore from "sharedHooks/useNavigateToExplore";

interface Props {
  taxon: ApiTaxon;
}

// Opens Explore on research-grade sound observations of the taxon, most faved first
export const useOpenTopSounds = ( ) => {
  const navigateToExplore = useNavigateToExplore( );
  return useCallback( ( taxon: ApiTaxon ) => navigateToExplore( {
    taxon,
    layout: "list",
    filters: { media: MEDIA.SOUNDS, researchGrade: true, needsID: false },
    sortBy: OBSERVATIONS_SORT.MOST_FAVED,
  } ), [navigateToExplore] );
};

const AudioIdSoundsLink = ( { taxon }: Props ) => {
  const openTopSounds = useOpenTopSounds( );
  return (
    <Body2
      onPress={( ) => openTopSounds( taxon )}
      accessibilityRole="link"
      accessibilityHint="Opens top-faved sound observations in Explore."
      className="mb-5 color-inatGreen underline"
    >
      Listen to top-faved sound observations
    </Body2>
  );
};

export default AudioIdSoundsLink;
