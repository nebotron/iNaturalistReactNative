import { navigationRef } from "navigation/navigationUtils";
import { NativeEventEmitter, NativeModules } from "react-native";
import type { UserLocation } from "sharedHelpers/fetchCoarseUserLocation";
import fetchCoarseUserLocation from "sharedHelpers/fetchCoarseUserLocation";
import { log } from "sharedHelpers/logger";
import createMmkvRecordStore, { AUDIO_ID_HEARD_MMKV_ID } from "sharedHelpers/mmkvRecordStore";
import { create } from "zustand";

import useAudioIdHistory, { clipPath, contextClipPath } from "./audioIdHistory";
import type { AudioIdSetup, AudioIdSpecies } from "./audioIdModel";
import { prepareAudioId } from "./audioIdModel";

// The Audio ID listening session, kept outside the screen so it carries on
// while the user is elsewhere in the app or the app is in the background. The
// AudioBirdId native module runs BirdNET on the last 5 s of microphone audio
// every second and emits probabilities for the species likely at the user's
// place and week (see audioIdModel.ts): the top one, and any that clear
// THRESHOLD. A species counts as heard when its score clears THRESHOLD and it
// is either the top species in that run or scores at least ALSO_HEARD: on
// held-out recordings this cut wrong species by about a quarter for under half
// a point of recall, while still showing confident overlapping callers.

type VibrateMode = "auto" | "core" | "system";

export const { AudioBirdId } = NativeModules as {
  AudioBirdId?: {
    start: (
      outputs: number[],
      minScore: number,
    ) => Promise<{ sampleRate: number; channels: number }>;
    stop: ( ) => void;
    setPlayingClip: ( playing: boolean ) => void;
    vibrate: ( mode: VibrateMode ) => Promise<{
      allowed: boolean; error: string | null; method: string; appState: number;
    }>;
    notify: ( title: string, body: string ) => void;
    geo: ( lat: number, lng: number, week: number ) => Promise<number[]>;
    saveClip: ( path: string, seconds: number, endFrame: number ) => Promise<string>;
    playClip: ( path: string ) => Promise<void>;
    playClipRange: ( path: string, from: number, to: number ) => Promise<void>;
    trimClip: ( path: string, from: number, to: number, outPath: string ) => Promise<string>;
    timeline: ( index: number, endFrame: number, seconds: number ) => Promise<( number | null )[]>;
    stopClip: ( ) => void;
  };
};

// Up from 0.3: on users' labeled detections it cut wrong birds from 23 to 8
// and lost 2 of 20 right ones; on held-out recordings, bird recall fell 1.2 points.
// Raised to 0.6 so everything listed as heard is also confident enough to alert on.
const THRESHOLD = 0.6;
const ALSO_HEARD = 0.7;
const DAY_MS = 86400000;
// Scores by output index, as the native module sends them
export type Scores = Record<number, number>;
export const heardIn = ( scores: Scores ) => {
  const top = Math.max( ...Object.values( scores ), 0 );
  return ( s: number ) => s >= THRESHOLD && ( s >= top || s >= ALSO_HEARD );
};

const logger = log.extend( "AudioId" );
// Runs summarized per log line, so field problems show up in the app log.
const LOG_EVERY = 30;

interface ScoresEvent {
  scores: Scores;
  level: number;
  // Native sample count at the window's end, for saving its clip
  windowFrame: number;
  inferMs: number;
  memMB: number;
  // Live spectrogram views on screen when it ran.
  spectrogramViews?: number;
  error: string | null;
}
export interface Heard {
  sp: AudioIdSpecies; lastHeard: number; best: number; count: number;
}

// The clip of each species' current call, by taxon ID.
const callClips = new Map<number, string>( );
// Pending saves of 15 s centered on each clip's window, by clip ID.
const contextTimers = new Map<string, ReturnType<typeof setTimeout>>( );
// Where listening started, for clips heard where no fix comes back.
let sessionLocation: UserLocation | null = null;

// Where in a 15 s context clip the call is, in seconds from its start, from
// the model's per-frame logits in 1/3 s bins: of the stretches of bins at 0 or
// more (or within 2 of the peak, when it is weaker), joined across gaps of up
// to 2/3 s, the strongest one in the 5 s window the call was heard in, padded
// by a bin each side to at least 1 s. On the 42 15 s clips labeled right it
// found a call in every one, 2 s long at the median.
const BINS_PER_S = 3;
const CONTEXT_S = 15;
const WINDOW_BINS = [5 * BINS_PER_S, 10 * BINS_PER_S - 1];
export const findCall = ( timeline: ( number | null )[] ): [number, number] | null => {
  const bins = timeline.map( b => b ?? -Infinity );
  const peak = Math.max( ...bins.slice( WINDOW_BINS[0], WINDOW_BINS[1] + 1 ) );
  if ( !Number.isFinite( peak ) ) return null;
  const on = Math.min( 0, peak - 2 );
  const stretches: [number, number][] = [];
  bins.forEach( ( b, i ) => {
    if ( b < on ) return;
    const last = stretches[stretches.length - 1];
    if ( last && i - last[1] <= 3 ) last[1] = i;
    else stretches.push( [i, i] );
  } );
  const best = ( [a, b]: [number, number] ) => Math.max( ...bins.slice( a, b + 1 ) );
  const call = stretches
    .filter( ( [a, b] ) => b >= WINDOW_BINS[0] && a <= WINDOW_BINS[1] )
    .sort( ( x, y ) => best( y ) - best( x ) )[0];
  if ( !call ) return null;
  let start = Math.max( 0, ( call[0] - 1 ) / BINS_PER_S );
  let end = Math.min( CONTEXT_S, ( call[1] + 2 ) / BINS_PER_S );
  if ( end - start < 1 ) {
    const mid = Math.min( Math.max( ( start + end ) / 2, 0.5 ), CONTEXT_S - 0.5 );
    start = mid - 0.5;
    end = mid + 0.5;
  }
  return [start, end];
};

// Keeps the 5 s clip of the run a call scored best in.
const saveCallClip = (
  sp: AudioIdSpecies,
  output: number,
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
    : history.addClip( sp, score ).id;
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
  // 5 s on, 15 s centered on this window can be saved, with where the call is in it.
  clearTimeout( contextTimers.get( id ) );
  contextTimers.set( id, setTimeout( ( ) => {
    contextTimers.delete( id );
    const endFrame = windowFrame + 5 * 32000;
    AudioBirdId?.saveClip( contextClipPath( id ), CONTEXT_S, endFrame )
      .then( ( ) => AudioBirdId?.timeline( output, endFrame, CONTEXT_S ) )
      .then( timeline => {
        const call = timeline && findCall( timeline );
        if ( call ) history.updateClip( id, { call } );
      } )
      .catch( ( e: Error ) => logger.error( `saving context clip failed: ${e.message}` ) );
  }, 5000 ) );
};

interface AudioIdState {
  listening: boolean;
  error: string | null;
  current: Scores | null; // null until the first run
  level: number;
  inferMs: number;
  heard: Record<number, Heard>; // by taxon ID
  setup: AudioIdSetup | null;
  seen: Set<number> | null; // null when signed out
  // Seen at research grade in the last 30 days
  recent: Set<number> | null;
  setSeen: ( seen: Set<number> | null, recent: Set<number> | null ) => void;
  start: ( ) => Promise<void>;
  stop: ( ) => void;
}

// What was heard is kept across app restarts, one key per species
const heardStore = createMmkvRecordStore<Heard>( AUDIO_ID_HEARD_MMKV_ID );
heardStore.migrateFrom( "audio-id-session", "heard" );

const useAudioIdSession = create<AudioIdState>( )( ( set, get ) => ( {
  listening: false,
  error: null,
  current: null,
  level: 0,
  inferMs: 0,
  heard: heardStore.loadAll( ),
  setup: null,
  seen: null,
  recent: null,
  setSeen: ( seen, recent ) => set( { seen, recent } ),
  start: async ( ) => {
    if ( !AudioBirdId ) {
      set( { error: "Audio ID is only available on iOS." } );
      return;
    }
    if ( get( ).listening ) return;
    set( { error: null } );
    callClips.clear( );
    try {
      const s = await prepareAudioId( AudioBirdId.geo );
      set( { setup: s } );
      sessionLocation = s.location;
      const mic = await AudioBirdId.start( s.outputs, THRESHOLD );
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

// "auto" uses Core Haptics in the foreground and the system vibration in the background
export const vibrate = ( mode: VibrateMode = "auto" ) => {
  AudioBirdId?.vibrate( mode )
    ?.then( r => {
      const detail = `${r.method}, mode ${mode}, app state ${r.appState}, `
        + `allowed ${r.allowed}: ${r.error}`;
      if ( !r.allowed || r.error ) logger.error( `vibrate blocked: ${detail}` );
      else logger.info( `vibrated: ${detail}` );
    } )
    .catch( ( e: Error ) => logger.error( `vibrate failed: ${e.message}` ) );
};

// While the screen is focused it dims after DIM_AFTER_MS without a touch, and
// an alert lifts the dimming for FLASH_MS. Dimming is an overlay on the screen,
// leaving the device brightness alone.
const DIM_AFTER_MS = 30000;
const FLASH_MS = 3000;
let focused = false;
let dimmed = false;
let flashing = false;
let dimTimer: ReturnType<typeof setTimeout> | undefined;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
export const useScreenDimmed = create<boolean>( ( ) => false );
const applyBrightness = ( ) => {
  useScreenDimmed.setState( focused && dimmed && !flashing, true );
};
// Returns whether the screen was dimmed, so the touch only wakes it
export const noteActivity = ( ) => {
  if ( !focused ) return false;
  clearTimeout( dimTimer );
  dimTimer = setTimeout( ( ) => {
    dimmed = true;
    applyBrightness( );
  }, DIM_AFTER_MS );
  if ( !dimmed ) return false;
  dimmed = false;
  applyBrightness( );
  return true;
};
export const startDimming = ( ) => {
  focused = true;
  dimmed = false;
  noteActivity( );
};
export const stopDimming = ( ) => {
  clearTimeout( dimTimer );
  clearTimeout( flashTimer );
  focused = false;
  dimmed = false;
  flashing = false;
  applyBrightness( );
};
const flashScreen = ( ) => {
  flashing = true;
  applyBrightness( );
  clearTimeout( flashTimer );
  flashTimer = setTimeout( ( ) => {
    flashing = false;
    applyBrightness( );
  }, FLASH_MS );
};

// The native module zeroes the mic audio while the app plays a sound, so
// playback isn't identified.
const players = new Set<object>( );
export const setPlayingAudio = ( player: object, playing: boolean ) => {
  if ( playing ) {
    players.add( player );
  } else {
    players.delete( player );
  }
  AudioBirdId?.setPlayingClip( players.size > 0 );
};

let runs: ScoresEvent[] = [];

const onScores = ( event: ScoresEvent ) => {
  const { level } = event;
  const {
    setup, seen, recent, heard,
  } = useAudioIdSession.getState( );
  const { scores } = event;
  const sps = setup?.species || [];
  runs.push( event );
  if ( runs.length >= LOG_EVERY ) {
    const best = runs.reduce( ( b, r ) => Object.entries( r.scores ).reduce(
      ( rb, [i, s] ) => ( s > rb.score
        ? { score: s, index: Number( i ) }
        : rb ),
      b,
    ), { score: 0, index: -1 } );
    const mean = ( f: ( r: ScoresEvent ) => number ) => runs
      .reduce( ( sum, r ) => sum + f( r ), 0 ) / runs.length;
    logger.info( `${runs.length} runs: level ${
      ( 20 * Math.log10( mean( r => r.level ) + 1e-9 ) ).toFixed( 0 )} dBFS, `
      + `infer ${mean( r => r.inferMs ).toFixed( 0 )} ms, `
      + `mem ${Math.round( runs[runs.length - 1].memMB )} MB, `
      + `spectrogram ${runs[runs.length - 1].spectrogramViews ?? "?"}, best ${
        best.index >= 0
          ? sps[best.index]?.commonName
          : "none"} ${best.score.toFixed( 2 )}, errors ${
        runs.filter( r => r.error ).length} ${runs.find( r => r.error )?.error || ""}` );
    runs = [];
  }
  const now = Date.now( );
  const isHeard = heardIn( scores );
  // Alert on a species not heard in the last 24 hours, and on every call of a
  // species the user hasn't observed at research grade in the last 30 days.
  const alerts: AudioIdSpecies[] = [];
  let next = heard;
  Object.entries( scores ).forEach( ( [i, s] ) => {
    const sp = sps[Number( i )];
    if ( !isHeard( s ) || !sp ) return;
    const old = next[sp.taxonId];
    const isNewCall = !old || now - old.lastHeard > 3000;
    saveCallClip( sp, Number( i ), s, isNewCall, event.windowFrame );
    if ( !old || now - old.lastHeard > DAY_MS
      || ( isNewCall && recent && !recent.has( sp.taxonId ) ) ) {
      alerts.push( sp );
    }
    const entry = {
      sp,
      lastHeard: now,
      best: Math.max( old?.best || 0, s ),
      count: ( old?.count || 0 ) + ( isNewCall
        ? 1
        : 0 ),
    };
    next = { ...next, [sp.taxonId]: entry };
    // lastHeard moves every run of a call; saving it only with a new call or
    // a better score keeps a call to one or two writes rather than one a second.
    if ( isNewCall || entry.best > ( old?.best || 0 ) ) heardStore.put( sp.taxonId, entry );
  } );
  if ( alerts.length > 0 ) {
    logger.info( `alert: ${alerts.map( sp => sp.commonName ).join( ", " )}` );
    vibrate( );
    flashScreen( );
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
