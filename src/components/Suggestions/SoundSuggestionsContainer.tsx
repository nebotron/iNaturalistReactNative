import { useNavigation, useRoute } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import { prepareAudioId } from "components/AudioId/audioIdModel";
import { AudioBirdId, isHeard } from "components/AudioId/audioIdSession";
import React, { useEffect } from "react";
import useStore from "stores/useStore";

import useNavigateWithTaxonSelected from "./hooks/useNavigateWithTaxonSelected";
import Suggestions from "./Suggestions";
import TaxonSearchButton from "./TaxonSearchButton";

// Other species shown at most, and the least score that shows one
const MAX_OTHER = 10;
const MIN_OTHER_SCORE = 0.05;

// Suggestions for an observation with sounds but no photos, from the on-device
// Audio ID model run over its first sound, with species limited to those
// likely at the observation's place and date. Like a heard species, the top
// suggestion has to clear Audio ID's threshold.
const scoreSound = async (
  uri: string,
  place: { latitude: number; longitude: number } | null,
  date: Date,
) => {
  if ( !AudioBirdId ) throw new Error( "Audio ID is unavailable" );
  const setup = await prepareAudioId( AudioBirdId.geo, place, date );
  const scores = await AudioBirdId.scoreSound( uri, setup.outputs );
  const ranked = setup.species
    .map( ( sp, i ) => ( {
      score: scores[i],
      combined_score: scores[i] * 100,
      taxon: {
        id: sp.taxonId,
        name: sp.name,
        preferred_common_name: sp.commonName,
        rank: "species",
        rank_level: 10,
        iconic_taxon_name: sp.bird
          ? "Aves"
          : undefined,
      },
    } ) )
    .sort( ( a, b ) => b.score - a.score );
  const topSuggestion = ranked[0] && isHeard( ranked[0].score )
    ? ranked[0]
    : null;
  return {
    topSuggestion,
    otherSuggestions: ranked
      .slice( topSuggestion
        ? 1
        : 0 )
      .filter( s => s.score >= MIN_OTHER_SCORE )
      .slice( 0, MAX_OTHER ),
  };
};

const headerRight = ( ) => <TaxonSearchButton />;

const SoundSuggestionsContainer = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const currentObservation = useStore( state => state.currentObservation );
  const sounds = currentObservation?.observationSounds
    || currentObservation?.observation_sounds;
  const soundUri: string | undefined = sounds?.[0]?.sound?.file_url;
  const { latitude, longitude } = currentObservation || {};
  const observedAt = currentObservation?.time_observed_at || currentObservation?.observed_on;
  const navigateWithTaxonSelected = useNavigateWithTaxonSelected( { vision: false } );

  const { data, isLoading } = useQuery( {
    queryKey: ["soundSuggestions", soundUri, latitude, longitude, observedAt],
    queryFn: ( ) => scoreSound( soundUri as string, latitude != null && longitude != null
      ? { latitude, longitude }
      : null, observedAt
      ? new Date( observedAt )
      : new Date( ) ),
    enabled: !!soundUri,
    retry: false,
  } );

  useEffect( ( ) => {
    navigation.setOptions( { headerRight } );
  }, [navigation] );

  return (
    <Suggestions
      fetchRemoteTaxa
      handleSkip={( ) => navigateWithTaxonSelected( undefined )}
      hideLocationToggleButton
      hideSkip={params?.hideSkip}
      improveWithLocationButtonOnPress={( ) => undefined}
      isLoading={!!soundUri && isLoading}
      shouldUseEvidenceLocation={latitude != null}
      onPressPhoto={( ) => undefined}
      onSelectGenus={( ) => undefined}
      onTaxonChosen={navigateWithTaxonSelected}
      photoUris={[]}
      selectedPhotoUri=""
      showImproveWithLocationButton={false}
      soundUri={soundUri}
      suggestions={data || { topSuggestion: null, otherSuggestions: [] }}
      toggleLocation={( ) => undefined}
      toggleSuggestionsModel={( ) => undefined}
      useOfflineModel={false}
    />
  );
};

export default SoundSuggestionsContainer;
