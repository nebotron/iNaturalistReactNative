import { INatIconButton } from "components/SharedComponents";
import React, { useEffect, useState } from "react";
import AudioRecorderPlayer from "react-native-audio-recorder-player";

import { clipPath } from "./audioIdHistory";

// Plays or stops one Audio ID clip.
const ClipPlayButton = ( { id }: { id: string } ) => {
  const [player] = useState( ( ) => new AudioRecorderPlayer( ) );
  const [playing, setPlaying] = useState( false );

  useEffect( ( ) => ( ) => {
    player.removePlayBackListener( );
    player.stopPlayer( ).catch( ( ) => undefined );
  }, [player] );

  const stop = async ( ) => {
    setPlaying( false );
    player.removePlayBackListener( );
    await player.stopPlayer( ).catch( ( ) => undefined );
  };

  const play = async ( ) => {
    setPlaying( true );
    try {
      await player.startPlayer( `file://${clipPath( id )}` );
      player.addPlayBackListener( e => {
        if ( e.duration > 0 && e.currentPosition >= e.duration ) stop( );
      } );
    } catch {
      setPlaying( false );
    }
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
