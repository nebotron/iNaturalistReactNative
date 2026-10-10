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

import type { AudioIdSetup, AudioIdSpecies } from "./audioIdModel";
import { prepareAudioId } from "./audioIdModel";

// Live ID of birds and other animals by sound (iOS). The AudioBirdId native
// module runs BirdNET on the last 5 s of microphone audio every second and
// emits one probability per species likely at the user's place and week (see
// audioIdModel.ts). A species counts as heard when its score clears THRESHOLD.

const { AudioBirdId } = NativeModules as {
  AudioBirdId?: {
    start: ( outputs: number[] ) => Promise<{ sampleRate: number; channels: number }>;
    stop: ( ) => void;
    geo: ( lat: number, lng: number, week: number ) => Promise<number[]>;
  };
};

const THRESHOLD = 0.3;

const logger = log.extend( "AudioId" );
// Runs summarized per log line, so field problems show up in the app log.
const LOG_EVERY = 30;

interface ScoresEvent { scores: number[]; level: number; inferMs: number; error: string | null }
interface Heard { sp: AudioIdSpecies; lastHeard: number; best: number; count: number }

type VibrateMode = "never" | "new" | "unseen";
const VIBRATE_OPTIONS: [VibrateMode, string][] = [
  ["never", "Never"],
  ["new", "A new bird"],
  ["unseen", "A bird I haven't seen"],
];
const settings = new MMKV( { id: "audio-id" } );
const VIBRATE_KEY = "vibrateMode";

// Animal classes the model covers, for asking which of them the user has seen.
const SEEN_TAXON_IDS = [
  3, // birds
  20978, // amphibians
  47158, // insects
  40151, // mammals
  26036, // reptiles
].join( "," );
const SEEN_MAX_PAGES = 10;

// Taxon IDs the user has research-grade observations of, including the
// ancestors of any subspecies-level observations. Needs the network; without
// it nothing is marked as not yet seen.
const useSeenTaxonIds = ( userId: number | undefined ): Set<number> => {
  const { data } = useAuthenticatedQuery(
    ["audioIdSeenTaxa", userId],
    async optsWithAuth => {
      const pages = [];
      for ( let page = 1; page <= SEEN_MAX_PAGES; page += 1 ) {
        // eslint-disable-next-line no-await-in-loop
        const p = await fetchSpeciesCounts( {
          user_id: userId,
          quality_grade: "research",
          taxon_id: SEEN_TAXON_IDS,
          per_page: 500,
          page,
        }, optsWithAuth );
        pages.push( p );
        if ( !p?.results || p.results.length < 500 ) break;
      }
      return pages;
    },
    { enabled: !!userId },
  );
  return useMemo( ( ) => {
    const ids = new Set<number>( );
    ( data || [] ).forEach( page => ( page?.results || [] ).forEach(
      ( r: { taxon: { id: number; ancestor_ids?: number[] } } ) => {
        ids.add( r.taxon.id );
        r.taxon.ancestor_ids?.forEach( id => ids.add( id ) );
      },
    ) );
    return ids;
  }, [data] );
};

const AudioId = ( ) => {
  const navigation = useNavigation( );
  const [listening, setListening] = useState( false );
  const [error, setError] = useState<string | null>( null );
  const [current, setCurrent] = useState<number[]>( [] );
  const [level, setLevel] = useState( 0 );
  const [heard, setHeard] = useState<Record<number, Heard>>( {} ); // by taxon ID
  const [setup, setSetup] = useState<AudioIdSetup | null>( null );
  const species = useMemo( ( ) => setup?.species || [], [setup] );
  const speciesRef = useRef<AudioIdSpecies[]>( [] );
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
      const s = await prepareAudioId( AudioBirdId.geo );
      speciesRef.current = s.species;
      setSetup( s );
      const mic = await AudioBirdId.start( s.outputs );
      logger.info( `started, ${s.species.length} species, located ${s.located}, `
        + `mic ${mic.sampleRate} Hz x${mic.channels}` );
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
      const sps = speciesRef.current;
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
              ? sps[best.index]?.commonName
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
        .map( ( s, i ) => ( s >= THRESHOLD && sps[i] && !heardRef.current.has( sps[i].taxonId )
          ? sps[i].taxonId
          : -1 ) )
        .filter( id => id >= 0 );
      firsts.forEach( id => heardRef.current.add( id ) );
      const { vibrateMode: mode, seen: seenIds } = alertRef.current;
      if (
        ( mode === "new" && firsts.length > 0 )
        || ( mode === "unseen" && firsts.some( id => !seenIds.has( id ) ) )
      ) {
        Vibration.vibrate( );
      }
      setHeard( h => {
        let next = h;
        scores.forEach( ( s, i ) => {
          const sp = sps[i];
          if ( s < THRESHOLD || !sp ) return;
          const old = next[sp.taxonId];
          const isNewCall = !old || now - old.lastHeard > 3000;
          next = {
            ...next,
            [sp.taxonId]: {
              sp,
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

  const outputOf = useMemo(
    ( ) => new Map( species.map( ( sp, i ) => [sp.taxonId, i] ) ),
    [species],
  );
  const scoreNow = ( taxonId: number ) => current[outputOf.get( taxonId ) ?? -1] || 0;
  const hearingNow = ( taxonId: number ) => listening && scoreNow( taxonId ) >= THRESHOLD;
  const heardList = Object.values( heard ).sort( ( a, b ) => b.lastHeard - a.lastHeard );
  const bestNow = current.length
    ? current.indexOf( Math.max( ...current ) )
    : -1;
  // RMS of -60 dBFS reads as empty, 0 dBFS as full.
  const meter = Math.max( 0, Math.min( 1, 1 + Math.log10( level + 1e-9 ) / 3 ) );

  const openTaxon = ( taxonId: number ) => navigation.navigate( "TaxonDetails", { id: taxonId } );

  // Species being heard right now are highlighted in yellow.
  const row = ( sp: AudioIdSpecies, score: number, detail?: string ) => (
    <Pressable
      key={sp.taxonId}
      accessibilityRole="button"
      accessibilityHint="Opens the species page."
      className={`flex-row items-center py-2 px-2 border-b border-lightGray ${
        hearingNow( sp.taxonId )
          ? "bg-yellow"
          : ""}`}
      onPress={( ) => openTaxon( sp.taxonId )}
    >
      <View className="flex-1">
        <Body1>{sp.commonName}</Body1>
        <List2 className="italic">{sp.name}</List2>
        {detail && <Body3>{detail}</Body3>}
        {currentUser && !seen.has( sp.taxonId ) && (
          <Body3 className="text-inatGreen">Not yet seen at research grade</Body3>
        )}
      </View>
      <Body1>{`${Math.round( score * 100 )}%`}</Body1>
    </Pressable>
  );

  return (
    <ScrollView className="bg-white h-full px-5 pt-4">
      <Body3 className="mb-3">
        {`Identifies ${setup
          ? `${species.length} birds and other animals${setup.located
            ? " likely here this week"
            : " (allow location to limit birds to those likely here)"}`
          : "birds and other animals"} by sound, on device and offline, `
          + "from the last 5 seconds of audio, and keeps listening with the app in the "
          + "background. Species you are hearing now are highlighted. Powered by BirdNET."}
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
          {bestNow >= 0 && species[bestNow]
            ? `Best guess: ${species[bestNow].commonName} ${
              Math.round( current[bestNow] * 100 )}% · ${inferMs.toFixed( 0 )} ms`
            : "Listening… first result after 5 seconds"}
        </Body3>
      )}

      <Heading4 className="mt-6 mb-1">HEARD THIS SESSION</Heading4>
      {heardList.length === 0 && <Body3 className="py-2">Nothing yet.</Body3>}
      {heardList.map( h => row(
        h.sp,
        hearingNow( h.sp.taxonId )
          ? scoreNow( h.sp.taxonId )
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
