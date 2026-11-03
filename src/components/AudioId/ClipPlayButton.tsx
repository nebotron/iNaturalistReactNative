import { INatIconButton } from "components/SharedComponents";
import React, { useEffect, useRef, useState } from "react";

import type { AudioIdClip } from "./audioIdHistory";
import { clipPath, contextClipPath } from "./audioIdHistory";
import { AudioBirdId, setPlayingAudio } from "./audioIdSession";

// Plays or stops one Audio ID clip: the call found in it, else its 5 s
// window. Starting another clip stops this one.
const ClipPlayButton = ( { clip }: { clip: AudioIdClip } ) => {
  const [player] = useState( ( ) => ( {} ) );
  const [playing, setPlaying] = useState( false );

  const playingRef = useRef( false );
  useEffect( ( ) => {
    setPlayingAudio( player, playing, ( ) => {
      playingRef.current = false;
      setPlaying( false );
    } );
    return ( ) => setPlayingAudio( player, false );
  }, [player, playing] );

  useEffect( ( ) => ( ) => {
    if ( playingRef.current ) AudioBirdId?.stopClip( );
  }, [] );

  const stop = ( ) => AudioBirdId?.stopClip( );

  const play = async ( ) => {
    setPlaying( true );
    playingRef.current = true;
    await ( clip.call
      ? AudioBirdId?.playClipRange( contextClipPath( clip.id ), clip.call[0], clip.call[1] )
      : AudioBirdId?.playClip( clipPath( clip.id ) ) )?.catch( ( ) => undefined );
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
