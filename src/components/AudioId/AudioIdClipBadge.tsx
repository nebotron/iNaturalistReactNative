import { INatIcon } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React from "react";
import colors from "styles/tailwindColors";

import useAudioIdHistory, { clipAround } from "./audioIdHistory";

interface Props {
  className: string;
  observation: {
    uuid: string;
    observed_on_string?: string | null;
    time_observed_at?: string | null;
  };
}

// Marks a grid tile whose observation has an Audio ID clip it could add.
const AudioIdClipBadge = ( { className, observation }: Props ) => {
  const observed = observation.observed_on_string || observation.time_observed_at;
  const time = observed
    ? new Date( observed ).getTime( )
    : NaN;
  const eligible = useAudioIdHistory( state => {
    if ( Number.isNaN( time ) ) return false;
    const clip = clipAround( state.clips, time );
    return !!clip && clip.observationUuid !== observation.uuid;
  } );

  if ( !eligible ) return null;
  return (
    <View
      pointerEvents="none"
      className={`absolute rounded-full bg-inatGreen p-1 ${className}`}
    >
      <INatIcon name="microphone" color={colors.white} size={12} />
    </View>
  );
};

export default AudioIdClipBadge;
