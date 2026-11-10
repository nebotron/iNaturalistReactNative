import {
  refresh as refreshNetInfo,
  useNetInfo,
} from "@react-native-community/netinfo";
import { useFocusEffect } from "@react-navigation/native";
import {
  normalizedSoundUri, playerStarted, setPlayingAudio,
} from "components/AudioId/audioIdSession";
import SoundSpectrogram, { SPECTROGRAM_HEIGHT } from "components/AudioId/SoundSpectrogram";
import {
  Body2,
  Body3,
  Body4,
  INatIcon,
  INatIconButton,
  OfflineNotice,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AudioRecorderPlayer from "react-native-audio-recorder-player";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

interface SoundContainerProps {
  autoPlay?: boolean;
  isVisible: boolean;
  sizeClass: string;
  sound: {
    file_url: string;
    // Absent on API sounds that were never moderated
    hidden?: boolean;
  };
}

const SoundContainer = ( {
  autoPlay,
  isVisible,
  sizeClass,
  sound,
}: SoundContainerProps ) => {
  const needsInternet = sound.file_url.includes( "https://" );
  const { isConnected } = useNetInfo( );
  const playerRef = useRef( new AudioRecorderPlayer( ) );
  const player = playerRef.current;
  const { t } = useTranslation( );
  // Track whether or not the sound is playing
  const [playing, setPlaying] = useState( false );

  // Track whether the user swiped away since last playing
  const [swipedAway, setSwipedAway] = useState( false );

  // Current progress and total duration of playback
  const [playBackState, setPlayBackState] = useState( {
    // Current position of playback in milliseconds
    currentPosition: 0,
    // Total duration of audio in milliseconds
    duration: 0,
    formattedCurrentPosition: "00:00",
    formattedDuration: "00:00",
  } );

  // Where a scrub that began before playback knew the duration should land,
  // as a fraction of the sound
  const pendingSeek = useRef<number | null>( null );
  // Where the playhead is being dragged, as a fraction of the sound
  const [dragAt, setDragAt] = useState<number | null>( null );
  const dragging = useRef( false );
  const width = useRef( 1 );
  // The playhead, as a fraction of the sound. As on the Audio ID clip
  // screen, it's moved by the wall clock from where playback started, not by
  // the player's position events, whose timing jitters and pulls it back and
  // forth.
  const [position, setPosition] = useState( 0 );
  const timer = useRef<ReturnType<typeof setInterval>>( undefined );
  const clock = useRef( { fromMs: 0, started: 0 } );
  const durationMs = useRef( 0 );

  const holdPlayhead = useCallback( ( fraction?: number ) => {
    clearInterval( timer.current );
    if ( fraction !== undefined ) setPosition( fraction );
  }, [] );

  // Move the playhead on from `fromMs` into the sound, starting now
  const startPlayhead = useCallback( ( fromMs: number ) => {
    clock.current = { fromMs, started: Date.now( ) };
    clearInterval( timer.current );
    timer.current = setInterval( ( ) => {
      const duration = durationMs.current;
      if ( dragging.current || duration <= 0 ) return;
      const { fromMs: from, started } = clock.current;
      setPosition( Math.min( ( from + Date.now( ) - started ) / duration, 1 ) );
    }, 50 );
  }, [] );

  useEffect( ( ) => ( ) => clearInterval( timer.current ), [] );

  const mmss = useCallback( ( value: number ) => player.mmss(
    Math.floor( value / 1000 ),
  ), [player] );

  const playSound = useCallback( ( from?: number ) => {
    async function playSoundAsync( ) {
      await player.setSubscriptionDuration( 0.1 );
      await player.startPlayer( await normalizedSoundUri( sound.file_url ) );
      playerStarted( );
      if ( from ) {
        try {
          await player.seekToPlayer( from );
        } catch ( seekPlayerError ) {
          if ( seekPlayerError instanceof Error && seekPlayerError.message.match( /Player has already stopped/ ) ) {
            // Something else might be wrong, but it's not really something to
            // bother the user with
            return;
          }
          throw seekPlayerError;
        }
      }
      startPlayhead( from || 0 );
      player.addPlayBackListener( playBackEvent => {
        durationMs.current = playBackEvent.duration;
        // A scrub made before the duration was known lands once it is
        if ( pendingSeek.current !== null && playBackEvent.duration > 0 ) {
          const at = pendingSeek.current * playBackEvent.duration;
          pendingSeek.current = null;
          player.seekToPlayer( at ).catch( ( ) => undefined );
          startPlayhead( at );
        }
        setPlayBackState( {
          currentPosition: playBackEvent.currentPosition,
          duration: playBackEvent.duration,
          formattedCurrentPosition: mmss( playBackEvent.currentPosition ),
          formattedDuration: mmss( playBackEvent.duration ),
        } );
        // Update UI when playback is complete
        if ( playBackEvent.currentPosition >= playBackEvent.duration ) {
          holdPlayhead( 1 );
          setPlaying( false );
        }
      } );
    }
    setSwipedAway( false );
    setPlaying( true );
    playSoundAsync( );
    return ( ) => {
      player.removePlayBackListener( );
    };
  }, [player, sound.file_url, mmss, startPlayhead, holdPlayhead] );

  const stopSound = useCallback( async ( ) => {
    holdPlayhead( );
    setPlaying( false );
    setSwipedAway( !isVisible );
    try {
      await player.pausePlayer( );
    } catch ( pausePlayerError ) {
      if ( pausePlayerError instanceof Error && pausePlayerError.message.match( /Player has already stopped/ ) ) {
        // Something else might be wrong, but it's not really something to
        // bother the user with
        return;
      }
      throw pausePlayerError;
    }
    player.removePlayBackListener( );
  }, [
    holdPlayhead,
    isVisible,
    player,
  ] );

  useEffect( ( ) => {
    setPlayingAudio( player, playing, ( ) => {
      player.removePlayBackListener( );
      holdPlayhead( );
      setPlaying( false );
      // Resuming has to re-init the player, as after a swipe
      setSwipedAway( true );
    } );
    return ( ) => setPlayingAudio( player, false );
  }, [holdPlayhead, player, playing] );

  // Tapping the button can play, pause, or resume
  const togglePlay = useCallback( ( ) => {
    if ( playing ) {
      stopSound( );
    } else if (
      playBackState.currentPosition > 0
      && playBackState.currentPosition < playBackState.duration
    ) {
      // player.resumePlayer() doesn't work if another sound was played after
      // this one was paused, so if we swiped away, we re-init the player and
      // seek to the previous position
      if ( swipedAway ) {
        playSound( playBackState.currentPosition );
      } else {
        // If we haven't swiped away, we can use resumePlayer, which also
        // seems to not cause the progress to jump back to 0 and then to the
        // current position
        setPlaying( true );
        // resumePlayer seemed to make slider stop when audio kept playing
        // when toggle was pressed repeatedly
        // occasionally jumps back to 0, havent been able to repicate consistently.
        playSound( playBackState.currentPosition );
      }
    } else {
      playSound( );
    }
  }, [
    playBackState.currentPosition,
    playBackState.duration,
    playing,
    playSound,
    swipedAway,
    stopSound] );

  // If the sound is no longer visible in the carousel (i.e. user swiped to a
  // different media item), stop playback
  useEffect( ( ) => {
    if ( !isVisible ) {
      stopSound( );
    }
  }, [
    isVisible,
    playBackState,
    sound,
    stopSound,
  ] );

  // User navigated to a different screen, stop playback. Note that this is
  // only using the cleanup function of useCallback
  useFocusEffect( useCallback( ( ) => async ( ) => {
    await stopSound( );
  }, [stopSound] ) );

  // if autoPlay was selected and this is visible, start playback automatically
  useEffect( ( ) => {
    if ( isVisible && autoPlay ) {
      playSound( );
    }
  }, [autoPlay, isVisible, playSound] );

  // Hear the sound from `fraction` of the way through it
  const seekTo = ( fraction: number ) => {
    const { duration } = playBackState;
    if ( duration <= 0 ) {
      pendingSeek.current = fraction;
      playSound( );
      return;
    }
    const at = Math.min( fraction, 0.999 ) * duration;
    holdPlayhead( at / duration );
    setPlayBackState( {
      ...playBackState,
      currentPosition: at,
      formattedCurrentPosition: mmss( at ),
    } );
    if ( playing ) {
      player.seekToPlayer( at ).catch( ( ) => undefined );
      startPlayhead( at );
    } else {
      playSound( at );
    }
  };

  // The gesture is made once, so it reads the latest seekTo through a ref.
  const latestSeekTo = useRef( seekTo );
  useLayoutEffect( ( ) => { latestSeekTo.current = seekTo; } );
  // A gesture-handler pan that takes the touch from the first point, so a
  // drag moves only the playhead and never pages the carousel it's in
  const scrub = useMemo( ( ) => {
    const fraction = ( x: number ) => Math.min( Math.max( x / width.current, 0 ), 1 );
    const dragTo = ( x: number ) => {
      dragging.current = true;
      setDragAt( fraction( x ) );
    };
    const release = ( x: number ) => {
      dragging.current = false;
      setDragAt( null );
      latestSeekTo.current( fraction( x ) );
    };
    const pan = Gesture.Pan( )
      .runOnJS( true )
      .minDistance( 0 )
      .maxPointers( 1 )
      .onStart( e => dragTo( e.x ) )
      .onUpdate( e => dragTo( e.x ) )
      .onEnd( e => release( e.x ) )
      .onFinalize( ( _e, success ) => {
        if ( !success && dragging.current ) {
          dragging.current = false;
          setDragAt( null );
        }
      } );
    const tap = Gesture.Tap( )
      .runOnJS( true )
      .onEnd( ( e, success ) => { if ( success ) release( e.x ); } );
    return Gesture.Race( pan, tap );
  }, [] );

  if ( sound.hidden ) {
    return (
      <View className={`${sizeClass} p-4 items-center justify-center`}>
        <View className="flex-row justify-center mb-2 gap-x-2">
          <INatIcon name="private" size={18} color={colors.white} />
          <Body2 className="text-white">{t( "Content-Hidden" )}</Body2>
        </View>
        <Body4 className="text-white text-center italic">
          {t( "This-sound-was-hidden-for-violating-community-guidelines-or-terms" )}
        </Body4>
      </View>
    );
  }

  if ( isConnected === false && needsInternet ) {
    return (
      <OfflineNotice
        onPress={( ) => refreshNetInfo( )}
        color="white"
      />
    );
  }
  let shownPosition = playBackState.formattedCurrentPosition;
  if ( dragAt !== null && playBackState.duration > 0 ) {
    shownPosition = mmss( dragAt * playBackState.duration );
  }

  // The same spectrogram interface as Audio ID clips: drag or tap anywhere on
  // it to hear the sound from there.
  return (
    <View className={`${sizeClass} justify-center px-4`}>
      <GestureDetector gesture={scrub}>
        <View
          className="rounded overflow-hidden"
          collapsable={false}
          style={{ height: SPECTROGRAM_HEIGHT }}
          onLayout={e => { width.current = e.nativeEvent.layout.width || 1; }}
        >
          <SoundSpectrogram uri={sound.file_url} />
          <View
            className="absolute h-full w-0.5 bg-warningRed"
            style={{ left: `${( dragAt ?? position ) * 100}%` }}
            pointerEvents="none"
          />
        </View>
      </GestureDetector>
      <View className="flex-row items-center">
        <INatIconButton
          icon={playing
            ? "pause"
            : "play"}
          onPress={togglePlay}
          color={colors.white}
          accessibilityLabel={playing
            ? t( "Pause--audio" )
            : t( "Play--audio" )}
          accessibilityHint={playing
            ? t( "Pauses-the-sound" )
            : t( "Plays-the-sound" )}
        />
        <Body3 className="text-white">
          {`${shownPosition} ${t( "sound-playback-separator" )} ${playBackState.formattedDuration}`}
        </Body3>
      </View>
    </View>
  );
};

export default SoundContainer;
