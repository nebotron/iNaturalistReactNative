import { navigationRef } from "navigation/navigationUtils";
import { NativeEventEmitter, NativeModules } from "react-native";
import type { UserLocation } from "sharedHelpers/fetchCoarseUserLocation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import { log } from "sharedHelpers/logger";
import { zustandStorage } from "stores/useStore";
import { create } from "zustand";
import type { StateStorage } from "zustand/middleware";
import { createJSONStorage, persist } from "zustand/middleware";

import useAudioIdHistory, { clipPath, contextClipPath } from "./audioIdHistory";
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
    setPlayingClip: ( playing: boolean ) => void;
    vibrate: ( ) => Promise<{ allowed: boolean; error: string | null }>;
    vibrateHaptics: ( ) => Promise<{ allowed: boolean; error: string | null }>;
    notify: ( title: string, body: string ) => void;
    geo: ( lat: number, lng: number, week: number ) => Promise<number[]>;
    saveClip: ( path: string, seconds: number, endFrame: number ) => Promise<string>;
  };
};

const THRESHOLD = 0.3;
const ALSO_HEARD = 0.7;
// Only vibrate/notify for calls above this confidence
const ALERT = 0.6;
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
  // Epoch ms when the window's last sample arrived
  windowEnd: number;
  // Native sample count at the window's end, for saving its clip
  windowFrame: number;
  inferMs: number;
  memMB: number;
  error: string | null;
}
export interface Heard {
  sp: AudioIdSpecies; lastHeard: number; best: number; count: number;
}

const heardTaxa = new Set<number>( );
// The clip of each species' current call, by taxon ID.
const callClips = new Map<number, string>( );
// Pending saves of 15 s centered on each clip's window, by clip ID.
const contextTimers = new Map<string, ReturnType<typeof setTimeout>>( );
let sessionId: string | undefined;
// Where listening started, for clips heard where no fix comes back.
let sessionLocation: UserLocation | null = null;

// Keeps the 5 s clip of the run a call scored best in.
const saveCallClip = (
  sp: AudioIdSpecies,
  score: number,
  isNewCall: boolean,
  windowFrame: number,
) => {
  const history = useAudioIdHistory.getState( );
  const existing = callClips.get( sp.taxonId );
  const clip = !isNewCall && existing
    ? history.clips[existing]
    : undefined;
  if ( clip && score <= clip.confidence ) return;
  const id = clip
    ? clip.id
    : history.addClip( sp, score, sessionId ).id;
  if ( clip ) {
    history.updateClip( id, { confidence: score } );
  } else {
    // Where it was heard, falling back to where listening started.
    fetchCoarseUserLocation( ).catch( ( ) => null ).then( loc => {
      const l = loc || sessionLocation;
      if ( l ) {
        history.updateClip( id, {
          location: {
            latitude: l.latitude, longitude: l.longitude, accuracy: l.positional_accuracy,
          },
        } );
      }
    } );
  }
  callClips.set( sp.taxonId, id );
  AudioBirdId?.saveClip( clipPath( id ), 5, windowFrame )
    .catch( ( e: Error ) => logger.error( `saving clip failed: ${e.message}` ) );
  // 5 s on, 15 s centered on this window can be saved.
  clearTimeout( contextTimers.get( id ) );
  contextTimers.set( id, setTimeout( ( ) => {
    contextTimers.delete( id );
    AudioBirdId?.saveClip( contextClipPath( id ), 15, windowFrame + 5 * 32000 )
      .catch( ( e: Error ) => logger.error( `saving context clip failed: ${e.message}` ) );
  }, 5000 ) );
};

interface AudioIdState {
  listening: boolean;
  error: string | null;
  current: number[];
  level: number;
  inferMs: number;
  heard: Record<number, Heard>; // by taxon ID
  setup: AudioIdSetup | null;
  seen: Set<number> | null; // null when signed out
  setSeen: ( seen: Set<number> | null ) => void;
  start: ( ) => Promise<void>;
  stop: ( ) => void;
}

// What was heard is kept across app restarts.
const useAudioIdSession = create<AudioIdState>( )( persist( ( set, get ) => ( {
  listening: false,
  error: null,
  current: [],
  level: 0,
  inferMs: 0,
  heard: {},
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
    callClips.clear( );
    try {
      const s = await prepareAudioId( AudioBirdId.geo );
      set( { setup: s } );
      sessionLocation = s.location;
      const mic = await AudioBirdId.start( s.outputs );
      logger.info( `started, ${s.species.length} species, located ${s.located}, `
        + `mic ${mic.sampleRate} Hz x${mic.channels}` );
      sessionId = useAudioIdHistory.getState( ).startSession( );
      set( { listening: true } );
    } catch ( e ) {
      logger.error( `start failed: ${( e as Error ).message}` );
      set( { error: ( e as Error ).message } );
    }
  },
  stop: ( ) => {
    AudioBirdId?.stop( );
    if ( sessionId ) useAudioIdHistory.getState( ).endSession( sessionId );
    sessionId = undefined;
    set( { listening: false } );
  },
} ), {
  name: "audio-id-session",
  storage: createJSONStorage( ( ) => zustandStorage as unknown as StateStorage ),
  partialize: state => ( { heard: state.heard } ),
} ) );

export const vibrate = ( haptics = false ) => {
  ( haptics
    ? AudioBirdId?.vibrateHaptics( )
    : AudioBirdId?.vibrate( ) )
    ?.then( r => {
      if ( !r.allowed || r.error ) logger.error( `vibrate blocked: ${r.error}` );
    } )
    .catch( ( e: Error ) => logger.error( `vibrate failed: ${e.message}` ) );
};

// Echo cancellation would need iOS voice processing, which also applies
// speech noise suppression and gain control that distort bird calls, so
// instead runs (and their clips) are dropped when their 5 s window overlaps
// any time the app was playing a sound. The tail covers speaker latency and
// the playback listener reporting the end late.
const WINDOW_MS = 5000;
const TAIL_MS = 1000;
const players = new Set<object>( );
let lastPlayed = 0;
export const setPlayingAudio = ( player: object, playing: boolean ) => {
  if ( playing ) {
    players.add( player );
  } else if ( players.delete( player ) ) {
    lastPlayed = Date.now( );
  }
  AudioBirdId?.setPlayingClip( players.size > 0 );
};
const overlapsPlayback = ( windowEnd: number ) => players.size > 0
  || windowEnd - WINDOW_MS < lastPlayed + TAIL_MS;

let runs: ScoresEvent[] = [];

const onScores = ( event: ScoresEvent ) => {
  const { level } = event;
  const {
    setup, seen, heard,
  } = useAudioIdSession.getState( );
  const { scores } = event;
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
  if ( overlapsPlayback( event.windowEnd || now ) ) {
    useAudioIdSession.setState( { level } );
    return;
  }
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
    saveCallClip( sp, s, isNewCall, event.windowFrame );
    if ( s > ALERT ) {
      if ( !heardTaxa.has( sp.taxonId ) || ( isNewCall && seen && !seen.has( sp.taxonId ) ) ) {
        alerts.push( sp );
      }
      heardTaxa.add( sp.taxonId );
    }
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
  if ( alerts.length > 0 ) {
    vibrate( );
    AudioBirdId?.notify(
      `Heard ${alerts.map( sp => sp.commonName ).join( ", " )}`,
      alerts.map( sp => ( seen && !seen.has( sp.taxonId )
        ? `${sp.commonName}: not yet seen at research grade`
        : sp.commonName ) ).join( "\n" ),
    );
  }
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
