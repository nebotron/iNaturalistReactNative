import { useNavigation, useRoute } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";
import { prepareAudioId } from "components/AudioId/audioIdModel";
import { AudioBirdId, isHeard } from "components/AudioId/audioIdSession";
import React, { useEffect, useState } from "react";
import useStore from "stores/useStore";

import useNavigateWithTaxonSelected from "./hooks/useNavigateWithTaxonSelected";
import useSelectGenus from "./hooks/useSelectGenus";
import Suggestions from "./Suggestions";
import TaxonSearchButton from "./TaxonSearchButton";

// The least score that shows a species: anything less displays as 0.0%
const MIN_OTHER_SCORE = 0.0005;

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
      .filter( s => s.score >= MIN_OTHER_SCORE ),
  };
};

const headerRight = ( ) => <TaxonSearchButton />;
const NO_SUGGESTIONS = { topSuggestion: null, otherSuggestions: [] };

export const soundUrisForObservation = ( observation ): string[] => (
  ( observation?.observationSounds || observation?.observation_sounds || [] )
    .map( os => os?.sound?.file_url )
    .filter( ( uri ): uri is string => !!uri )
);

interface Props {
  // When the photo suggestions screen hands over to a sound, it owns which
  // sound is selected and what happens when a photo thumbnail is tapped.
  detectSubject?: boolean;
  onPressPhoto?: ( _uri: string ) => void;
  onPressSound?: ( _uri: string ) => void;
  photoUris?: string[];
  soundUri?: string;
}

const SoundSuggestionsContainer = ( {
  detectSubject,
  onPressPhoto,
  onPressSound,
  photoUris = [],
  soundUri: controlledSoundUri,
}: Props ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const currentObservation = useStore( state => state.currentObservation );
  const soundUris = soundUrisForObservation( currentObservation );
  const [ownSoundUri, setOwnSoundUri] = useState<string | undefined>( );
  const soundUri: string | undefined = controlledSoundUri
    ?? ( ownSoundUri && soundUris.includes( ownSoundUri )
      ? ownSoundUri
      : soundUris[0] );
  const { latitude, longitude } = currentObservation || {};
  // A new local observation has only observed_on_string until it's uploaded,
  // and without it the geomodel would use this week rather than the sound's.
  const observedAt = currentObservation?.time_observed_at
    || currentObservation?.observed_on_string
    || currentObservation?.observed_on;
  const observedTime = Date.parse( observedAt ?? "" );
  const navigateWithTaxonSelected = useNavigateWithTaxonSelected( { vision: false } );

  const { data, isLoading } = useQuery( {
    queryKey: ["soundSuggestions", soundUri, latitude, longitude, observedTime],
    queryFn: ( ) => scoreSound( soundUri as string, latitude != null && longitude != null
      ? { latitude, longitude }
      : null, Number.isNaN( observedTime )
      ? new Date( )
      : new Date( observedTime ) ),
    enabled: !!soundUri,
    retry: false,
  } );
  const suggestions = data || NO_SUGGESTIONS;
  const { genusEligibleTaxonIds, handleSelectGenus } = useSelectGenus(
    suggestions,
    navigateWithTaxonSelected,
  );

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
      detectSubject={detectSubject}
      onPressPhoto={onPressPhoto ?? ( ( ) => undefined )}
      onPressSound={onPressSound ?? setOwnSoundUri}
      genusEligibleTaxonIds={genusEligibleTaxonIds}
      onSelectGenus={handleSelectGenus}
      onTaxonChosen={navigateWithTaxonSelected}
      photoUris={photoUris}
      selectedPhotoUri=""
      showImproveWithLocationButton={false}
      soundUri={soundUri}
      soundUris={soundUris}
      suggestions={suggestions}
      toggleLocation={( ) => undefined}
      toggleSuggestionsModel={( ) => undefined}
      useOfflineModel={false}
    />
  );
};

export default SoundSuggestionsContainer;
