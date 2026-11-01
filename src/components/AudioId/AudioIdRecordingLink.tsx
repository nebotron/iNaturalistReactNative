/* eslint-disable i18next/no-literal-string */
import { useNavigation } from "@react-navigation/native";
import { Body3, INatIcon } from "components/SharedComponents";
import { Pressable } from "components/styledComponents";
import React from "react";

import useAudioIdHistory, { clipAround } from "./audioIdHistory";

interface Props {
  currentObservation?: { observed_on_string?: string; time_observed_at?: string } | null;
}

// Offers the Audio ID clip heard around the observation's time, if any.
const AudioIdRecordingLink = ( { currentObservation }: Props ) => {
  const navigation = useNavigation( );
  const observed = currentObservation?.observed_on_string
    || currentObservation?.time_observed_at;
  const time = observed
    ? new Date( observed ).getTime( )
    : NaN;
  const clip = useAudioIdHistory( state => ( Number.isNaN( time )
    ? undefined
    : clipAround( state.clips, time ) ) );

  if ( !clip ) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens the Audio ID clip heard around this time."
      className="flex-row items-center pt-2"
      onPress={( ) => navigation.navigate( "AudioIdRecording", { id: clip.id, time } )}
    >
      <INatIcon name="microphone" size={14} />
      <Body3 className="ml-2 color-inatGreen">
        {`Add sound from Audio ID (${clip.sp.commonName})`}
      </Body3>
    </Pressable>
  );
};

export default AudioIdRecordingLink;
