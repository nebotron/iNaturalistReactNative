import type { EbirdLimit } from "components/Explore/hooks/useEbirdObservations";
import useEbirdObservations from "components/Explore/hooks/useEbirdObservations";
import {
  ActivityIndicator, Body3, Body4, Checkbox, Heading4,
} from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React, { useState } from "react";
import { Linking } from "react-native";
import { formatDifferenceForHumans } from "sharedHelpers/dateAndTime";
import { useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

const COLLAPSED_COUNT = 3;

interface Props {
  enabled?: boolean;
  params: Record<string, unknown>;
}

const EbirdResults = ( { enabled = true, params }: Props ) => {
  const { t, i18n } = useTranslation( );
  const [expanded, setExpanded] = useState( false );
  const ebirdEnabled = useStore( state => state.layout.ebirdEnabled );
  const setEbirdEnabled = useStore( state => state.layout.setEbirdEnabled );
  const ebird = useEbirdObservations( params, enabled && ebirdEnabled );
  const limitTexts: Record<EbirdLimit, string> = {
    area: t( "eBird-limit-area" ),
    dates: t( "eBird-limit-dates" ),
    noLocation: t( "eBird-limit-no-location" ),
    rate: t( "eBird-limit-rate" ),
    results: t( "eBird-limit-results" ),
  };
  if ( !ebird ) return null;
  const checkbox = (
    <Checkbox
      accessibilityLabel={t( "Include-eBird-sightings" )}
      text={t( "Include-eBird-sightings" )}
      isChecked={ebirdEnabled}
      onPress={( ) => setEbirdEnabled( !ebirdEnabled )}
    />
  );
  if ( !ebirdEnabled ) return <View className="mx-4 my-3">{checkbox}</View>;
  const {
    error, isLoading, limits, observations,
  } = ebird;
  const shown = expanded
    ? observations
    : observations.slice( 0, COLLAPSED_COUNT );

  return (
    <View className="mx-4 my-3 p-3 rounded-lg border border-lightGray" testID="EbirdResults">
      {checkbox}
      <Heading4 className="mt-3">
        {t( "eBird-recent-sightings", { count: observations.length } )}
      </Heading4>
      {isLoading && <ActivityIndicator size={20} />}
      {error && <Body3 className="mt-2">{t( "eBird-results-unavailable" )}</Body3>}
      {limits.length > 0 && (
        <View className="mt-2" testID="EbirdResults.limits">
          <Body3 className="text-warningRed">{t( "eBird-results-incomplete" )}</Body3>
          {limits.map( limit => (
            <Body4 key={limit} className="text-warningRed">{limitTexts[limit]}</Body4>
          ) )}
        </View>
      )}
      {shown.map( obs => (
        <Pressable
          key={`${obs.subId}-${obs.speciesCode}`}
          accessibilityRole="link"
          accessibilityHint={t( "Opens-eBird-checklist" )}
          className="mt-2"
          onPress={( ) => Linking.openURL( `https://ebird.org/checklist/${obs.subId}` )}
        >
          <Body3>{obs.comName}</Body3>
          <Body4>{obs.locName}</Body4>
          <Body4>
            {formatDifferenceForHumans( obs.obsDt.replace( " ", "T" ), i18n )}
            {obs.howMany
              ? ` · ${t( "eBird-individuals-count", { count: obs.howMany } )}`
              : ""}
          </Body4>
        </Pressable>
      ) )}
      {observations.length > COLLAPSED_COUNT && (
        <Pressable
          accessibilityRole="button"
          className="mt-2"
          onPress={( ) => setExpanded( !expanded )}
        >
          <Body3 className="underline">
            {expanded
              ? t( "Show-fewer-eBird-sightings" )
              : t( "Show-all-eBird-sightings" )}
          </Body3>
        </Pressable>
      )}
    </View>
  );
};

export default EbirdResults;
