import { INatIconButton } from "components/SharedComponents";
import React from "react";
import colors from "styles/tailwindColors";
import { create } from "zustand";

import { AudioBirdId } from "./audioIdSession";

// Whether Audio ID clips play with background noise filtered out. The saved
// clips stay as recorded; the filter only applies to playback.
const usePlaybackFilter = create<{ filtered: boolean }>( ( ) => ( { filtered: false } ) );

// Switches clip playback between filtered and original; takes effect on the
// next play.
const PlaybackFilterButton = ( ) => {
  const filtered = usePlaybackFilter( state => state.filtered );
  const toggle = ( ) => {
    AudioBirdId?.setPlaybackFilter( !filtered );
    usePlaybackFilter.setState( { filtered: !filtered } );
  };
  return (
    <INatIconButton
      icon="sliders"
      color={filtered
        ? colors.inatGreen
        : colors.mediumGray}
      onPress={toggle}
      accessibilityLabel={filtered
        ? "Noise filter on"
        : "Noise filter off"}
      accessibilityHint="Switches playback between filtered and original audio."
    />
  );
};

export default PlaybackFilterButton;
