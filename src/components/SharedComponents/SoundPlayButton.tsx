import { NavigationContext } from "@react-navigation/native";
import {
  normalizedSoundUri, playerStarted, setPlayingAudio,
} from "components/AudioId/audioIdSession";
import INatIconButton from "components/SharedComponents/Buttons/INatIconButton";
import React, {
  useCallback, useContext, useEffect, useState,
} from "react";
import AudioRecorderPlayer from "react-native-audio-recorder-player";
import useTranslation from "sharedHooks/useTranslation";

interface Props {
  className?: string;
  color?: string;
  dropShadow?: boolean;
  size?: number;
  uri: string;
}

// Plays or stops one sound, e.g. over an observation's thumbnail.
const SoundPlayButton = ( {
  className,
  color,
  dropShadow,
  size,
  uri,
}: Props ) => {
  const { t } = useTranslation( );
  const [player] = useState( ( ) => new AudioRecorderPlayer( ) );
  const [playing, setPlaying] = useState( false );

  useEffect( ( ) => {
    setPlayingAudio( player, playing, ( ) => {
      player.removePlayBackListener( );
      setPlaying( false );
    } );
    return ( ) => setPlayingAudio( player, false );
  }, [player, playing] );

  const stop = useCallback( async ( ) => {
    setPlaying( false );
    player.removePlayBackListener( );
    await player.stopPlayer( ).catch( ( ) => undefined );
  }, [player] );

  // Stop when unmounted, recycled for another sound, or the screen blurs
  useEffect( ( ) => ( ) => { stop( ); }, [stop, uri] );
  // Read the context directly so this also renders outside a navigator
  const navigation = useContext( NavigationContext );
  useEffect( ( ) => navigation?.addListener( "blur", ( ) => { stop( ); } ), [navigation, stop] );

  const play = async ( ) => {
    setPlaying( true );
    try {
      await player.startPlayer( await normalizedSoundUri( uri ) );
      playerStarted( );
      player.addPlayBackListener( e => {
        if ( e.duration > 0 && e.currentPosition >= e.duration ) stop( );
      } );
    } catch {
      setPlaying( false );
    }
  };

  return (
    <INatIconButton
      className={className}
      color={color}
      dropShadow={dropShadow}
      size={size}
      icon={playing
        ? "stop"
        : "play"}
      onPress={playing
        ? stop
        : play}
      accessibilityLabel={playing
        ? t( "Stop--audio" )
        : t( "Play--audio" )}
      accessibilityHint={playing
        ? t( "Stops-the-sound" )
        : t( "Plays-the-sound" )}
    />
  );
};

export default SoundPlayButton;
