/* eslint-disable i18next/no-literal-string */
import { Body2 } from "components/SharedComponents";
import React from "react";
import { openExternalWebBrowser } from "sharedHelpers/util";

interface Props {
  taxonId: number;
}

// Research-grade sound observations of the taxon, most faved first
export const openTopSounds = ( taxonId: number ) => openExternalWebBrowser(
  "https://www.inaturalist.org/observations?sounds=true&quality_grade=research"
    + `&order_by=votes&taxon_id=${taxonId}`,
);

const AudioIdSoundsLink = ( { taxonId }: Props ) => (
  <Body2
    onPress={( ) => openTopSounds( taxonId )}
    accessibilityRole="link"
    accessibilityHint="Opens top-faved sound observations in the browser."
    className="mb-5 color-inatGreen underline"
  >
    Listen to top-faved sound observations
  </Body2>
);

export default AudioIdSoundsLink;
