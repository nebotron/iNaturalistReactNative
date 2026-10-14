import { navigationRef } from "navigation/navigationUtils";
import { NativeEventEmitter, NativeModules } from "react-native";
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
    vibrate: ( ) => Promise<{ allowed: boolean; error: string | null }>;
    notify: ( title: string, body: string ) => void;
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

interface ScoresEvent {
  scores: number[];
  level: number;
  inferMs: number;
  memMB: number;
  error: string | null;
  spectrogram?: number[][];
}
export interface Heard {
  sp: AudioIdSpecies; lastHeard: number; best: number; count: number; color: string;
}
// Spectrogram columns, each colored by the top species heard in its run.
// id counts up, so a column keeps its identity as the window scrolls.
export interface SpectrogramColumn { id: number; bins: number[]; color: string | null }
const SPECTROGRAM_COLUMNS = 80; // 10 s

// One color per species heard this session, in the order first heard.
const PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#bfef45", "#9a6324", "#469990",
];

const heardTaxa = new Set<number>( );

interface AudioIdState {
  listening: boolean;
  error: string | null;
  current: number[];
  level: number;
  inferMs: number;
  heard: Record<number, Heard>; // by taxon ID
  spectrogram: SpectrogramColumn[];
  setup: AudioIdSetup | null;
  seen: Set<number> | null; // null when signed out
  setSeen: ( seen: Set<number> | null ) => void;
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
  spectrogram: [],
  setup: null,
  seen: null,
  setSeen: seen => set( { seen } ),
  start: async ( ) => {
    if ( !AudioBirdId ) {
      set( { error: "Audio ID is only available on iOS." } );
      return;
    }
    if ( get( ).listening ) return;
    set( { error: null } );
    heardTaxa.clear( );
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

let runs: ScoresEvent[] = [];
let nextColumnId = 0;

const onScores = ( event: ScoresEvent ) => {
  const { scores, level } = event;
  const {
    setup, seen, heard,
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
      + `infer ${mean( r => r.inferMs ).toFixed( 0 )} ms, `
      + `mem ${Math.round( runs[runs.length - 1].memMB )} MB, best ${
        best.index >= 0
          ? sps[best.index]?.commonName
          : "none"} ${best.score.toFixed( 2 )}, errors ${
        runs.filter( r => r.error ).length} ${runs.find( r => r.error )?.error || ""}` );
    runs = [];
  }
  const now = Date.now( );
  const isHeard = heardIn( scores );
  // Alert on the first call of each species this session, and on every call
  // of a species the user hasn't observed at research grade.
  const alerts: AudioIdSpecies[] = [];
  let next = heard;
  scores.forEach( ( s, i ) => {
    const sp = sps[i];
    if ( !isHeard( s ) || !sp ) return;
    const old = next[sp.taxonId];
    const isNewCall = !old || now - old.lastHeard > 3000;
    if ( !heardTaxa.has( sp.taxonId ) || ( isNewCall && seen && !seen.has( sp.taxonId ) ) ) {
      alerts.push( sp );
    }
    heardTaxa.add( sp.taxonId );
    next = {
      ...next,
      [sp.taxonId]: {
        sp,
        lastHeard: now,
        best: Math.max( old?.best || 0, s ),
        color: old?.color || PALETTE[Object.keys( next ).length % PALETTE.length],
        count: ( old?.count || 0 ) + ( isNewCall
          ? 1
          : 0 ),
      },
    };
  } );
  const top = scores.indexOf( Math.max( ...scores ) );
  const color = top >= 0 && isHeard( scores[top] ) && sps[top]
    ? next[sps[top].taxonId]?.color || null
    : null;
  const spectrogram = [
    ...useAudioIdSession.getState( ).spectrogram,
    ...( event.spectrogram || [] ).map( bins => {
      nextColumnId += 1;
      return { id: nextColumnId, bins, color };
    } ),
  ].slice( -SPECTROGRAM_COLUMNS );
  if ( alerts.length > 0 ) {
    AudioBirdId?.vibrate( )
      .then( r => {
        if ( !r.allowed || r.error ) logger.error( `vibrate blocked: ${r.error}` );
      } )
      .catch( ( e: Error ) => logger.error( `vibrate failed: ${e.message}` ) );
    AudioBirdId?.notify(
      `Heard ${alerts.map( sp => sp.commonName ).join( ", " )}`,
      alerts.map( sp => ( seen && !seen.has( sp.taxonId )
        ? `${sp.name}: not yet seen at research grade`
        : sp.name ) ).join( "\n" ),
    );
  }
  useAudioIdSession.setState( {
    current: scores,
    spectrogram,
    level,
    inferMs: event.inferMs,
    heard: next,
    ...( event.error
      ? { error: `Model error: ${event.error}` }
      : {} ),
  } );
};

if ( AudioBirdId ) {
  const emitter = new NativeEventEmitter( AudioBirdId as never );
  emitter.addListener( "AudioBirdIdScores", onScores );
  emitter.addListener( "AudioBirdIdStatus", ( message: string ) => logger.info( message ) );
  emitter.addListener( "AudioBirdIdOpen", ( ) => {
    if ( !navigationRef.isReady( ) ) return;
    navigationRef.navigate( "TabNavigator", {
      screen: "MenuTab",
      params: { screen: "AudioId" },
    } );
  } );
}

export default useAudioIdSession;
