/* eslint-disable i18next/no-literal-string */
import { CachesDirectoryPath, exists } from "@dr.pogodin/react-native-fs";
import Slider from "@react-native-community/slider";
import { useNavigation, useRoute } from "@react-navigation/native";
import {
  Body1, Body3, Button, INatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, { useEffect, useRef, useState } from "react";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";
import * as uuid from "uuid";

import useAudioIdHistory, { clipPath, contextClipPath } from "./audioIdHistory";
import { AudioBirdId, setPlayingAudio } from "./audioIdSession";

interface Span { path: string; startMs: number; endMs: number }

// The Audio ID clip heard around an observation's time: scrub through it,
// trim it and add it to the observation. The 15 s context clip ends 5 s after
// the call's window, which ends about when the clip was heard; clips from
// before those were saved fall back to the 5 s window.
const AudioIdRecording = ( ) => {
  const navigation = useNavigation( );
  const { params } = useRoute( );
  const { id, time } = params as { id: string; time: number };
  const clip = useAudioIdHistory( state => state.clips[id] );
  const updateClip = useAudioIdHistory( state => state.updateClip );
  const currentObservation = useStore( state => state.currentObservation );
  const observations = useStore( state => state.observations );
  const currentObservationIndex = useStore( state => state.currentObservationIndex );
  const updateObservations = useStore( state => state.updateObservations );
  const [span, setSpan] = useState<Span | null>( null );
  const [error, setError] = useState<string | null>( null );
  // In seconds from the span's start
  const [position, setPosition] = useState( 0 );
  const [trim, setTrim] = useState<[number, number]>( [0, 0] );
  const [playing, setPlaying] = useState( false );
  const [player] = useState( ( ) => ( {} ) );
  const timer = useRef<ReturnType<typeof setInterval>>( undefined );
  const playingRef = useRef( false );

  const heardAt = clip?.time;
  useEffect( ( ) => {
    if ( !heardAt ) return;
    exists( contextClipPath( id ) ).then( hasContext => {
      const s = hasContext
        ? { path: contextClipPath( id ), startMs: heardAt - 10000, endMs: heardAt + 5000 }
        : { path: clipPath( id ), startMs: heardAt - 5000, endMs: heardAt };
      const duration = ( s.endMs - s.startMs ) / 1000;
      setSpan( s );
      setTrim( [0, duration] );
      setPosition( Math.min( Math.max( ( time - s.startMs ) / 1000, 0 ), duration ) );
    } );
  }, [id, heardAt, time] );

  useEffect( ( ) => {
    setPlayingAudio( player, playing );
    return ( ) => setPlayingAudio( player, false );
  }, [player, playing] );

  useEffect( ( ) => ( ) => {
    clearInterval( timer.current );
    if ( playingRef.current ) AudioBirdId?.stopClip( );
  }, [] );

  const stop = ( ) => AudioBirdId?.stopClip( );

  const play = async ( at: number ) => {
    if ( !span ) return;
    const from = at >= trim[0] && at < trim[1] - 0.1
      ? at
      : trim[0];
    const started = Date.now( );
    setPlaying( true );
    playingRef.current = true;
    clearInterval( timer.current );
    timer.current = setInterval( ( ) => setPosition(
      Math.min( from + ( Date.now( ) - started ) / 1000, trim[1] ),
    ), 50 );
    await AudioBirdId?.playClipRange( span.path, from, trim[1] ).catch( ( ) => undefined );
    clearInterval( timer.current );
    playingRef.current = false;
    setPlaying( false );
  };

  const addToObservation = async ( ) => {
    if ( !span || !AudioBirdId ) return;
    try {
      // Sound.new moves the file, so it gets its own.
      const out = `${CachesDirectoryPath}/${uuid.v4( )}.m4a`;
      await AudioBirdId.trimClip( span.path, trim[0], trim[1], out );
      const obsSound = await ObservationSound.new( `file://${out}` );
      const updated = [...observations];
      updated[currentObservationIndex] = Observation
        .appendObsSounds( [obsSound], currentObservation );
      updateClip( id, { observationUuid: currentObservation?.uuid } );
      updateObservations( updated );
      navigation.goBack( );
    } catch ( e ) {
      setError( `Couldn't add the sound: ${( e as Error ).message}` );
    }
  };

  if ( !clip ) return <Body3 className="p-5">This clip is no longer saved.</Body3>;
  if ( error ) return <Body3 className="p-5">{error}</Body3>;
  if ( !span ) return null;

  const duration = ( span.endMs - span.startMs ) / 1000;
  // Seconds relative to the observation's time
  const label = ( at: number ) => {
    const s = ( span.startMs + at * 1000 - time ) / 1000;
    return `${s >= 0
      ? "+"
      : "−"}${Math.abs( s ).toFixed( 1 )} s`;
  };
  const percent = ( at: number ) => `${( at / duration ) * 100}%`;
  const obsAt = ( time - span.startMs ) / 1000;

  return (
    <View className="bg-white h-full px-5 pt-4">
      <Body1>{clip.sp.commonName}</Body1>
      <Body3 className="mt-1">
        Drag to scrub, set where the clip starts and ends, then add it.
      </Body3>

      <View className="mt-6 h-8 mx-4 rounded bg-lightGray overflow-hidden">
        <View
          className="absolute h-full bg-inatGreenDisabled"
          style={{ left: percent( trim[0] ), width: percent( trim[1] - trim[0] ) }}
        />
        {obsAt >= 0 && obsAt <= duration && (
          <View
            className="absolute h-full w-0.5 bg-darkGray"
            style={{ left: percent( obsAt ) }}
          />
        )}
        <View
          className="absolute h-full w-0.5 bg-inatGreen"
          style={{ left: percent( position ) }}
        />
      </View>
      <Slider
        minimumValue={0}
        maximumValue={duration}
        value={position}
        minimumTrackTintColor={colors.inatGreen}
        thumbTintColor={colors.inatGreen}
        tapToSeek
        onSlidingStart={stop}
        onValueChange={setPosition}
        onSlidingComplete={at => {
          setPosition( at );
          play( at );
        }}
      />
      <View className="flex-row items-center justify-between">
        <Body3>{label( position )}</Body3>
        <INatIconButton
          icon={playing
            ? "stop"
            : "play"}
          onPress={playing
            ? stop
            : ( ) => play( position )}
          accessibilityLabel={playing
            ? "Stop"
            : "Play"}
          accessibilityHint={playing
            ? "Stops the recording."
            : "Plays the trimmed clip from the playhead."}
        />
        <Body3>{`Clip ${( trim[1] - trim[0] ).toFixed( 1 )} s`}</Body3>
      </View>

      <View className="flex-row mt-4">
        <Button
          className="flex-1 mr-2"
          text={`START ${label( trim[0] )}`}
          accessibilityHint="Starts the clip at the playhead."
          disabled={position >= trim[1]}
          onPress={( ) => setTrim( [position, trim[1]] )}
        />
        <Button
          className="flex-1 ml-2"
          text={`END ${label( trim[1] )}`}
          accessibilityHint="Ends the clip at the playhead."
          disabled={position <= trim[0]}
          onPress={( ) => setTrim( [trim[0], position] )}
        />
      </View>
      <Button
        className="mt-4"
        level="focus"
        text="ADD TO OBSERVATION"
        onPress={addToObservation}
      />
    </View>
  );
};

export default AudioIdRecording;
