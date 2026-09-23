/* eslint-disable i18next/no-literal-string */
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  Body1, Body3, Button, Heading4, List2,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, { useCallback, useRef, useState } from "react";
import { NativeEventEmitter, NativeModules } from "react-native";
import colors from "styles/tailwindColors";

import AUDIO_ID_SPECIES from "./audioIdSpecies";

// Live bird ID by sound (iOS). The AudioBirdId native module runs the on-device
// model on the last 3 s of microphone audio every 0.5 s and emits one
// probability per species. A species counts as heard when its score, averaged
// over the last two runs, clears that species' threshold (tuned on validation
// data in scripts/bird_audio/train20.py).

const { AudioBirdId } = NativeModules as {
  AudioBirdId?: { start: ( ) => Promise<boolean>; stop: ( ) => void };
};

interface ScoresEvent { scores: number[]; level: number }
interface Heard { index: number; lastHeard: number; best: number; count: number }

const AudioId = ( ) => {
  const navigation = useNavigation( );
  const [listening, setListening] = useState( false );
  const [error, setError] = useState<string | null>( null );
  const [current, setCurrent] = useState<number[]>( [] );
  const [level, setLevel] = useState( 0 );
  const [heard, setHeard] = useState<Record<number, Heard>>( {} );
  const previous = useRef<number[]>( [] );

  const stop = useCallback( ( ) => {
    AudioBirdId?.stop( );
    setListening( false );
    previous.current = [];
  }, [] );

  const start = useCallback( async ( ) => {
    if ( !AudioBirdId ) {
      setError( "Audio ID is only available on iOS." );
      return;
    }
    setError( null );
    try {
      await AudioBirdId.start( );
      setListening( true );
    } catch ( e ) {
      setError( ( e as Error ).message );
    }
  }, [] );

  useFocusEffect( useCallback( ( ) => {
    if ( !AudioBirdId ) return ( ) => undefined;
    const emitter = new NativeEventEmitter( AudioBirdId as never );
    const sub = emitter.addListener( "AudioBirdIdScores", ( { scores, level: l }: ScoresEvent ) => {
      const prev = previous.current.length === scores.length
        ? previous.current
        : scores;
      const smoothed = scores.map( ( s, i ) => ( s + prev[i] ) / 2 );
      previous.current = scores;
      setCurrent( smoothed );
      setLevel( l );
      const now = Date.now( );
      setHeard( h => {
        let next = h;
        smoothed.forEach( ( s, i ) => {
          if ( s < AUDIO_ID_SPECIES[i].threshold ) return;
          const old = next[i];
          const isNewCall = !old || now - old.lastHeard > 3000;
          next = {
            ...next,
            [i]: {
              index: i,
              lastHeard: now,
              best: Math.max( old?.best || 0, s ),
              count: ( old?.count || 0 ) + ( isNewCall
                ? 1
                : 0 ),
            },
          };
        } );
        return next;
      } );
    } );
    return ( ) => {
      sub.remove( );
      stop( );
    };
  }, [stop] ) );

  const hearingNow = current
    .map( ( s, i ) => ( { s, i } ) )
    .filter( ( { s, i } ) => s >= AUDIO_ID_SPECIES[i].threshold )
    .sort( ( a, b ) => b.s - a.s );
  const candidates = current
    .map( ( s, i ) => ( { s, i } ) )
    .filter( ( { s, i } ) => s < AUDIO_ID_SPECIES[i].threshold && s >= 0.1 )
    .sort( ( a, b ) => b.s - a.s )
    .slice( 0, 3 );
  const heardList = Object.values( heard ).sort( ( a, b ) => b.lastHeard - a.lastHeard );
  // RMS of -60 dBFS reads as empty, 0 dBFS as full.
  const meter = Math.max( 0, Math.min( 1, 1 + Math.log10( level + 1e-9 ) / 3 ) );

  const openTaxon = ( i: number ) => navigation.navigate( "TaxonDetails", {
    id: AUDIO_ID_SPECIES[i].taxonId,
  } );

  const row = ( i: number, score: number, detail?: string ) => (
    <Pressable
      key={i}
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className="flex-row items-center py-2 border-b border-lightGray"
      onPress={( ) => openTaxon( i )}
    >
      <View className="flex-1">
        <Body1>{AUDIO_ID_SPECIES[i].commonName}</Body1>
        <List2 className="italic">{AUDIO_ID_SPECIES[i].name}</List2>
        {detail && <Body3>{detail}</Body3>}
      </View>
      <Body1>{`${Math.round( score * 100 )}%`}</Body1>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <Body3 className="mb-3">
        {`Identifies ${AUDIO_ID_SPECIES.length} common Seattle-area birds by sound, `
          + "on device, from the last 3 seconds of audio."}
      </Body3>
      <Button
        level={listening
          ? "warning"
          : "focus"}
        text={listening
          ? "STOP LISTENING"
          : "START LISTENING"}
        onPress={listening
          ? stop
          : start}
      />
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}
      {listening && (
        <View className="h-2 bg-lightGray rounded-full mt-4 overflow-hidden">
          <View
            className="h-2 rounded-full"
            style={{ width: `${meter * 100}%`, backgroundColor: colors.inatGreen }}
          />
        </View>
      )}

      <Heading4 className="mt-6 mb-1">HEARING NOW</Heading4>
      {hearingNow.length === 0 && (
        <Body3 className="py-2">
          {listening
            ? "No bird recognized."
            : "Not listening."}
        </Body3>
      )}
      {hearingNow.map( ( { s, i } ) => row( i, s ) )}
      {candidates.length > 0 && (
        <>
          <Heading4 className="mt-6 mb-1">MAYBE</Heading4>
          {candidates.map( ( { s, i } ) => row( i, s ) )}
        </>
      )}

      <Heading4 className="mt-6 mb-1">HEARD THIS SESSION</Heading4>
      {heardList.length === 0 && <Body3 className="py-2">Nothing yet.</Body3>}
      {heardList.map( h => row(
        h.index,
        h.best,
        `${h.count} ${h.count === 1
          ? "time"
          : "times"}, last at ${new Date( h.lastHeard ).toLocaleTimeString( )}`,
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioId;
