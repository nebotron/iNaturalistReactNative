import { NativeEventEmitter, NativeModules, Vibration } from "react-native";
import { MMKV } from "react-native-mmkv";
import { log } from "sharedHelpers/logger";
import { create } from "zustand";

import type { AudioIdSetup, AudioIdSpecies } from "./audioIdModel";
import { prepareAudioId } from "./audioIdModel";

// The Audio ID listening session, kept outside the screen so it carries on
// while the user is elsewhere in the app or the app is in the background. The
// AudioBirdId native module runs BirdNET on the last 5 s of microphone audio
// every second and emits one probability per species likely at the user's
// place and week (see audioIdModel.ts). A species counts as heard when its
// score clears THRESHOLD and it is either the top species in that run or
// scores at least ALSO_HEARD: on held-out recordings this cut wrong species by
// about a quarter for under half a point of recall, while still showing
// confident overlapping callers.

const { AudioBirdId } = NativeModules as {
  AudioBirdId?: {
    start: ( outputs: number[] ) => Promise<{ sampleRate: number; channels: number }>;
    stop: ( ) => void;
    geo: ( lat: number, lng: number, week: number ) => Promise<number[]>;
  };
};

const THRESHOLD = 0.3;
const ALSO_HEARD = 0.7;
export const heardIn = ( scores: number[] ) => {
  const top = Math.max( ...scores, 0 );
  return ( s: number ) => s >= THRESHOLD && ( s >= top || s >= ALSO_HEARD );
};

const logger = log.extend( "AudioId" );
// Runs summarized per log line, so field problems show up in the app log.
const LOG_EVERY = 30;

interface ScoresEvent { scores: number[]; level: number; inferMs: number; error: string | null }
export interface Heard { sp: AudioIdSpecies; lastHeard: number; best: number; count: number }

export type VibrateMode = "never" | "new" | "unseen";
const settings = new MMKV( { id: "audio-id" } );
const VIBRATE_KEY = "vibrateMode";

interface AudioIdState {
  listening: boolean;
  error: string | null;
  current: number[];
  level: number;
  inferMs: number;
  heard: Record<number, Heard>; // by taxon ID
  setup: AudioIdSetup | null;
  vibrateMode: VibrateMode;
  seen: Set<number>;
  setVibrateMode: ( mode: VibrateMode ) => void;
  setSeen: ( seen: Set<number> ) => void;
  start: ( ) => Promise<void>;
  stop: ( ) => void;
}

const useAudioIdSession = create<AudioIdState>( ( set, get ) => ( {
  listening: false,
  error: null,
  current: [],
  level: 0,
  inferMs: 0,
  heard: {},
  setup: null,
  vibrateMode: ( settings.getString( VIBRATE_KEY ) as VibrateMode ) || "never",
  seen: new Set( ),
  setVibrateMode: mode => {
    settings.set( VIBRATE_KEY, mode );
    set( { vibrateMode: mode } );
  },
  setSeen: seen => set( { seen } ),
  start: async ( ) => {
    if ( !AudioBirdId ) {
      set( { error: "Audio ID is only available on iOS." } );
      return;
    }
    if ( get( ).listening ) return;
    set( { error: null } );
    try {
      const s = await prepareAudioId( AudioBirdId.geo );
      set( { setup: s } );
      const mic = await AudioBirdId.start( s.outputs );
      logger.info( `started, ${s.species.length} species, located ${s.located}, `
        + `mic ${mic.sampleRate} Hz x${mic.channels}` );
      set( { listening: true } );
    } catch ( e ) {
      logger.error( `start failed: ${( e as Error ).message}` );
      set( { error: ( e as Error ).message } );
    }
  },
  stop: ( ) => {
    AudioBirdId?.stop( );
    set( { listening: false } );
  },
} ) );

const heardTaxa = new Set<number>( );
let runs: ScoresEvent[] = [];

const onScores = ( event: ScoresEvent ) => {
  const { scores, level } = event;
  const {
    setup, vibrateMode, seen, heard,
  } = useAudioIdSession.getState( );
  const sps = setup?.species || [];
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
  const now = Date.now( );
  const isHeard = heardIn( scores );
  const firsts = scores
    .map( ( s, i ) => ( isHeard( s ) && sps[i] && !heardTaxa.has( sps[i].taxonId )
      ? sps[i].taxonId
      : -1 ) )
    .filter( id => id >= 0 );
  firsts.forEach( id => heardTaxa.add( id ) );
  if (
    ( vibrateMode === "new" && firsts.length > 0 )
    || ( vibrateMode === "unseen" && firsts.some( id => !seen.has( id ) ) )
  ) {
    Vibration.vibrate( );
  }
  let next = heard;
  scores.forEach( ( s, i ) => {
    const sp = sps[i];
    if ( !isHeard( s ) || !sp ) return;
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
  useAudioIdSession.setState( {
    current: scores,
    level,
    inferMs: event.inferMs,
    heard: next,
    ...( event.error
      ? { error: `Model error: ${event.error}` }
      : {} ),
  } );
};

if ( AudioBirdId ) {
  new NativeEventEmitter( AudioBirdId as never ).addListener( "AudioBirdIdScores", onScores );
}

export default useAudioIdSession;
