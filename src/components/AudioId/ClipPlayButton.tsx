import { INatIconButton } from "components/SharedComponents";
import React, { useEffect, useRef, useState } from "react";

import { clipPath } from "./audioIdHistory";
import { AudioBirdId, setPlayingAudio } from "./audioIdSession";

// Plays or stops one Audio ID clip. Starting another clip stops this one.
const ClipPlayButton = ( { id }: { id: string } ) => {
  const [player] = useState( ( ) => ( {} ) );
  const [playing, setPlaying] = useState( false );

  useEffect( ( ) => {
    setPlayingAudio( player, playing );
    return ( ) => setPlayingAudio( player, false );
  }, [player, playing] );

  const playingRef = useRef( false );
  useEffect( ( ) => ( ) => {
    if ( playingRef.current ) AudioBirdId?.stopClip( );
  }, [] );

  const stop = ( ) => AudioBirdId?.stopClip( );

  const play = async ( ) => {
    setPlaying( true );
    playingRef.current = true;
    await AudioBirdId?.playClip( clipPath( id ) ).catch( ( ) => undefined );
    playingRef.current = false;
    setPlaying( false );
  };

  return (
    <INatIconButton
      icon={playing
        ? "stop"
        : "play"}
      onPress={playing
        ? stop
        : play}
      accessibilityLabel={playing
        ? "Stop"
        : "Play"}
      accessibilityHint={playing
        ? "Stops the clip."
        : "Plays the clip."}
    />
  );
};

export default ClipPlayButton;
