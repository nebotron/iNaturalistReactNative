/* eslint-disable i18next/no-literal-string */
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { fetchSpeciesCounts } from "api/observations";
import {
  Body1, Body3, Button, Heading4, List2,
} from "components/SharedComponents";
import { Pressable, ScrollView, View } from "components/styledComponents";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { NativeEventEmitter, NativeModules, Vibration } from "react-native";
import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";
import { useCurrentUser } from "sharedHooks";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";
import colors from "styles/tailwindColors";

import AUDIO_ID_SPECIES from "./audioIdSpecies";

// Live bird ID by sound (iOS). The AudioBirdId native module runs BirdNET on
// the last 5 s of microphone audio every second and emits one probability per
// Seattle-area species. A species counts as heard when its score clears that
// species' threshold.

const { AudioBirdId } = NativeModules as {
  AudioBirdId?: {
    start: ( ) => Promise<{ sampleRate: number; channels: number }>;
    stop: ( ) => void;
  };
};

const logger = log.extend( "AudioId" );
// Runs summarized per log line, so field problems show up in the app log.
const LOG_EVERY = 30;

interface ScoresEvent { scores: number[]; level: number; inferMs: number; error: string | null }
interface Heard { index: number; lastHeard: number; best: number; count: number }

type VibrateMode = "never" | "new" | "unseen";
const VIBRATE_OPTIONS: [VibrateMode, string][] = [
  ["never", "Never"],
  ["new", "A new bird"],
  ["unseen", "A bird I haven't seen"],
];
const settings = new MMKV( { id: "audio-id" } );
const VIBRATE_KEY = "vibrateMode";

// Taxon IDs the user has research-grade observations of, including the
// ancestors of any subspecies-level observations, limited to the model's species.
const useSeenTaxonIds = ( userId?: number ): Set<number> => {
  const params = {
    user_id: userId,
    quality_grade: "research",
    taxon_id: AUDIO_ID_SPECIES.map( sp => sp.taxonId ).join( "," ),
    per_page: 500,
  };
  const { data } = useAuthenticatedQuery(
    ["audioIdSeenTaxa", params],
    optsWithAuth => fetchSpeciesCounts( params, optsWithAuth ),
    { enabled: !!userId },
  );
  return useMemo( ( ) => {
    const ids = new Set<number>( );
    ( data?.results || [] ).forEach( ( r: { taxon: { id: number; ancestor_ids?: number[] } } ) => {
      ids.add( r.taxon.id );
      r.taxon.ancestor_ids?.forEach( id => ids.add( id ) );
    } );
    return ids;
  }, [data] );
};

const AudioId = ( ) => {
  const navigation = useNavigation( );
  const [listening, setListening] = useState( false );
  const [error, setError] = useState<string | null>( null );
  const [current, setCurrent] = useState<number[]>( [] );
  const [level, setLevel] = useState( 0 );
  const [heard, setHeard] = useState<Record<number, Heard>>( {} );
  const [inferMs, setInferMs] = useState( 0 );
  const heardRef = useRef<Set<number>>( new Set( ) );
  const [vibrateMode, setVibrateModeState] = useState<VibrateMode>(
    ( ) => ( settings.getString( VIBRATE_KEY ) as VibrateMode ) || "never",
  );
  const setVibrateMode = ( mode: VibrateMode ) => {
    settings.set( VIBRATE_KEY, mode );
    setVibrateModeState( mode );
  };
  const currentUser = useCurrentUser( );
  const seen = useSeenTaxonIds( currentUser?.id );
  // The score listener is registered once per focus; read these through refs.
  const alertRef = useRef( { vibrateMode, seen } );
  useEffect( ( ) => {
    alertRef.current = { vibrateMode, seen };
  }, [vibrateMode, seen] );

  const stop = useCallback( ( ) => {
    AudioBirdId?.stop( );
    setListening( false );
  }, [] );

  const start = useCallback( async ( ) => {
    if ( !AudioBirdId ) {
      setError( "Audio ID is only available on iOS." );
      return;
    }
    setError( null );
    try {
      const mic = await AudioBirdId.start( );
      logger.info( `started, mic ${mic.sampleRate} Hz x${mic.channels}` );
      setListening( true );
    } catch ( e ) {
      logger.error( `start failed: ${( e as Error ).message}` );
      setError( ( e as Error ).message );
    }
  }, [] );

  useFocusEffect( useCallback( ( ) => {
    if ( !AudioBirdId ) return ( ) => undefined;
    const emitter = new NativeEventEmitter( AudioBirdId as never );
    let runs: ScoresEvent[] = [];
    const sub = emitter.addListener( "AudioBirdIdScores", ( event: ScoresEvent ) => {
      const { scores, level: l } = event;
      runs.push( event );
      if ( runs.length >= LOG_EVERY ) {
        const best = runs.reduce( ( b, r ) => {
          const top = Math.max( ...r.scores, 0 );
          return top > b.score
            ? { score: top, index: r.scores.indexOf( top ) }
            : b;
        }, { score: 0, index: -1 } );
        const mean = ( f: ( r: ScoresEvent ) => number ) => runs
          .reduce( ( sum, r ) => sum + f( r ), 0 ) / runs.length;
        logger.info( `${runs.length} runs: level ${
          ( 20 * Math.log10( mean( r => r.level ) + 1e-9 ) ).toFixed( 0 )} dBFS, `
          + `infer ${mean( r => r.inferMs ).toFixed( 0 )} ms, best ${
            best.index >= 0
              ? AUDIO_ID_SPECIES[best.index].commonName
              : "none"} ${best.score.toFixed( 2 )}, errors ${
            runs.filter( r => r.error ).length} ${runs.find( r => r.error )?.error || ""}` );
        runs = [];
      }
      if ( event.error ) setError( `Model error: ${event.error}` );
      setCurrent( scores );
      setLevel( l );
      setInferMs( event.inferMs );
      const now = Date.now( );
      const firsts = scores
        .map( ( s, i ) => ( s >= AUDIO_ID_SPECIES[i].threshold && !heardRef.current.has( i )
          ? i
          : -1 ) )
        .filter( i => i >= 0 );
      firsts.forEach( i => heardRef.current.add( i ) );
      const { vibrateMode: mode, seen: seenIds } = alertRef.current;
      if (
        ( mode === "new" && firsts.length > 0 )
        || ( mode === "unseen"
          && firsts.some( i => !seenIds.has( AUDIO_ID_SPECIES[i].taxonId ) ) )
      ) {
        Vibration.vibrate( );
      }
      setHeard( h => {
        let next = h;
        scores.forEach( ( s, i ) => {
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

  const hearingNow = ( i: number ) => listening
    && ( current[i] || 0 ) >= AUDIO_ID_SPECIES[i].threshold;
  const heardList = Object.values( heard ).sort( ( a, b ) => b.lastHeard - a.lastHeard );
  const bestNow = current.length
    ? current.indexOf( Math.max( ...current ) )
    : -1;
  // RMS of -60 dBFS reads as empty, 0 dBFS as full.
  const meter = Math.max( 0, Math.min( 1, 1 + Math.log10( level + 1e-9 ) / 3 ) );

  const openTaxon = ( i: number ) => navigation.navigate( "TaxonDetails", {
    id: AUDIO_ID_SPECIES[i].taxonId,
  } );

  // Birds being heard right now are highlighted in yellow.
  const row = ( i: number, score: number, detail?: string ) => (
    <Pressable
      key={i}
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className={`flex-row items-center py-2 px-2 border-b border-lightGray ${hearingNow( i )
        ? "bg-yellow"
        : ""}`}
      onPress={( ) => openTaxon( i )}
    >
      <View className="flex-1">
        <Body1>{AUDIO_ID_SPECIES[i].commonName}</Body1>
        <List2 className="italic">{AUDIO_ID_SPECIES[i].name}</List2>
        {detail && <Body3>{detail}</Body3>}
        {currentUser && !seen.has( AUDIO_ID_SPECIES[i].taxonId ) && (
          <Body3 className="text-inatGreen">Not yet seen at research grade</Body3>
        )}
      </View>
      <Body1>{`${Math.round( score * 100 )}%`}</Body1>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <Body3 className="mb-3">
        {`Identifies ${AUDIO_ID_SPECIES.length} Seattle-area birds by sound, on device, `
          + "from the last 5 seconds of audio, and keeps listening with the app in the "
          + "background. Birds you are hearing now are highlighted. Powered by BirdNET."}
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
      <Body3 className="mt-4 mb-1">Vibrate when I hear:</Body3>
      <View className="flex-row">
        {VIBRATE_OPTIONS.map( ( [mode, label] ) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: vibrateMode === mode }}
            className={`flex-1 mr-1 py-2 rounded-lg border border-darkGray ${
              vibrateMode === mode
                ? "bg-darkGray"
                : ""
            }`}
            onPress={( ) => setVibrateMode( mode )}
          >
            <Body3
              className={`text-center ${vibrateMode === mode
                ? "text-white"
                : ""}`}
            >
              {label}
            </Body3>
          </Pressable>
        ) )}
      </View>
      {error && <Body3 className="mt-2 text-warningRed">{error}</Body3>}
      {listening && (
        <View className="h-2 bg-lightGray rounded-full mt-4 overflow-hidden">
          <View
            className="h-2 rounded-full"
            style={{ width: `${meter * 100}%`, backgroundColor: colors.inatGreen }}
          />
        </View>
      )}
      {listening && (
        <Body3 className="mt-1">
          {bestNow >= 0
            ? `Best guess: ${AUDIO_ID_SPECIES[bestNow].commonName} ${
              Math.round( current[bestNow] * 100 )}% · ${inferMs.toFixed( 0 )} ms`
            : "Listening… first result after 5 seconds"}
        </Body3>
      )}

      <Heading4 className="mt-6 mb-1">HEARD THIS SESSION</Heading4>
      {heardList.length === 0 && <Body3 className="py-2">Nothing yet.</Body3>}
      {heardList.map( h => row(
        h.index,
        hearingNow( h.index )
          ? current[h.index]
          : h.best,
        `${h.count} ${h.count === 1
          ? "time"
          : "times"}, last at ${new Date( h.lastHeard ).toLocaleTimeString( )}`,
      ) )}
      <View className="h-20" />
    </ScrollView>
  );
};

export default AudioId;
