import type useEbirdObservations from "components/Explore/hooks/useEbirdObservations";
import type { EbirdLimit } from "components/Explore/hooks/useEbirdObservations";
import { Body3, Body4 } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import { useTranslation } from "sharedHooks";

interface Props {
  ebird: ReturnType<typeof useEbirdObservations>;
}

// Why eBird sightings, which appear among the results, may be missing
const EbirdNotice = ( { ebird }: Props ) => {
  const { t } = useTranslation( );
  if ( !ebird || ( !ebird.error && ebird.limits.length === 0 ) ) return null;
  const limitTexts: Record<EbirdLimit, string> = {
    area: t( "eBird-limit-area" ),
    dates: t( "eBird-limit-dates-window" ),
    filters: t( "eBird-limit-filters" ),
    noLocation: t( "eBird-limit-no-location" ),
    rate: t( "eBird-limit-rate" ),
    results: t( "eBird-limit-results" ),
  };
  return (
    <View className="mx-4 my-3 p-3 rounded-lg border border-lightGray" testID="EbirdNotice">
      {ebird.error
        ? <Body3>{t( "eBird-results-unavailable" )}</Body3>
        : <Body3 className="text-warningRed">{t( "eBird-results-incomplete" )}</Body3>}
      {ebird.limits.map( limit => (
        <Body4 key={limit} className="text-warningRed">{limitTexts[limit]}</Body4>
      ) )}
    </View>
  );
};

export default EbirdNotice;
