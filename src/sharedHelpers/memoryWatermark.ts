import type { QueryClient } from "@tanstack/react-query";
import { AppState, NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "memoryWatermark" );

// iOS kills the app for memory without anything reaching the log. The Nov 18
// kill came in the crop editor with the footprint already at 2.6GB when it
// opened, and nothing said which screen had taken it there. So log the screens
// visited, with the footprint on each, whenever the footprint reaches a new
// step (1.5GB, 2GB, ...): once per step per launch, so only heavy sessions log.
//
// The two Nov 20 kills (Audio ID listening in the background; a minute into
// the camera) climbed ~25 MB/s with only that total on record, so each step
// now also logs a native snapshot of what the memory is (see
// ImageCropper.memorySnapshot: kernel ledgers, dirty memory by VM tag and its
// growth since the last step, the largest allocations, malloc zones) and what
// the app was doing (setMemoryContext). The last snapshot at a high footprint
// is kept on disk, and the next launch logs it, since a kill logs nothing.
//
// The Nov 25 kill climbed ~1 GB at a time while browsing Explore, in small
// native allocations, on the build that started caching map tiles on disk.
// So every sample also reads counters from the map's tile layers and the image
// pipeline (ImageCropper.memoryCounters), and a jump of JUMP_MB between two
// samples logs memory_jump with what each counter did over it, whatever the
// total, to say which of them the memory went to.
const FIRST_STEP_MB = 1536;
const STEP_MB = 512;
// Sampled between screen changes too, since memory also grows within one
// screen (a bulk crop, a scrolling grid). Faster once high, since the
// footprint has climbed 25 MB/s to the limit from there.
const SAMPLE_MS = 10_000;
const HIGH_SAMPLE_MS = 2_000;
const HIGH_MB = 2048;
// How often the on-disk snapshot is refreshed while the footprint is high
const PERSIST_MS = 10_000;
const TRAIL_LENGTH = 10;
const JUMP_MB = 250;
// Only between samples this close together, so a jump is attributable
const JUMP_MAX_GAP_MS = 15_000;
const JUMP_MIN_INTERVAL_MS = 30_000;
const MAX_JUMPS_LOGGED = 20;

interface MemoryStats { footprintMB: number; freeMB: number }

type MemoryContext = Record<string, unknown>;

type MemoryCounters = Record<string, Record<string, number>>;

// iOS only; elsewhere there is nothing to sample and this all does nothing.
const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    memoryStats?: ( ) => Promise<MemoryStats>;
    memorySnapshot?: ( context: MemoryContext | null ) => Promise<Record<string, unknown>>;
    memoryCounters?: ( ) => Promise<MemoryCounters>;
    takePreviousMemorySnapshot?: ( ) => Promise<( MemoryStats & {
      at?: number;
      context?: MemoryContext;
    } ) | null>;
  };
};
const memoryStats = ( ): Promise<MemoryStats> | null => ImageCropper?.memoryStats?.( ) ?? null;

let screen = "unknown";
// "Screen:footprintMB" for the screens visited, oldest first.
const trail: string[] = [];
let highestStepLogged = 0;
let started = false;
let persistedAt = 0;
let persistedHigh = false;
const contexts: Record<string, MemoryContext> = {};
let lastSample: { footprintMB: number; at: number; counters: MemoryCounters | null } | null = null;
let lastJumpAt = 0;
let jumpsLogged = 0;

// How each counter changed between two samples, leaving out those that didn't
const counterChanges = ( before: MemoryCounters | null, after: MemoryCounters | null ) => {
  if ( !before || !after ) return null;
  const changes: Record<string, Record<string, number>> = {};
  Object.entries( after ).forEach( ( [source, values] ) => {
    Object.entries( values ).forEach( ( [key, value] ) => {
      const change = value - ( before[source]?.[key] ?? 0 );
      if ( change === 0 ) return;
      changes[source] = { ...changes[source], [key]: Math.round( change * 10 ) / 10 };
    } );
  } );
  return changes;
};

// What a feature that holds a lot of memory is doing, for the snapshots: the
// camera's photos taken, Audio ID's listening time and runs. undefined clears.
export const setMemoryContext = ( key: string, value?: MemoryContext ) => {
  if ( value ) {
    contexts[key] = value;
  } else {
    delete contexts[key];
  }
};

let queryClient: QueryClient | undefined;

// The React Query cache to count in the snapshots
export const setMemoryQueryClient = ( client: QueryClient ) => {
  queryClient = client;
};

// The three launches that ended past 2.7GB (Nov 26-27) held 2.1-2.3GB in
// malloc_small, which the native counters don't account for. These say how
// much of it is the JS heap, and how much the React Query cache holds: queries,
// how many have a screen observing them, infinite-query pages, and the items
// in their results arrays.
const jsHeap = ( ) => {
  if ( typeof HermesInternal === "undefined" ) return null;
  // React Native types HermesInternal as {}; getInstrumentedStats is Hermes's
  const hermes = HermesInternal as {
    getInstrumentedStats?: ( ) => { js_heapSize?: number; js_allocatedBytes?: number };
  } | null;
  const stats = hermes?.getInstrumentedStats?.( );
  if ( !stats?.js_heapSize ) return null;
  return {
    heapMB: Math.round( stats.js_heapSize / 1048576 ),
    allocatedMB: Math.round( ( stats.js_allocatedBytes ?? 0 ) / 1048576 ),
  };
};

const resultsLength = ( value: unknown ): number => {
  const { results } = ( value ?? {} ) as { results?: unknown };
  if ( !Array.isArray( results ) ) return 0;
  return results.length;
};

const queryCacheCounts = ( ) => {
  if ( !queryClient ) return null;
  const queries = queryClient.getQueryCache( ).getAll( );
  let observed = 0;
  let pages = 0;
  let results = 0;
  queries.forEach( query => {
    if ( query.getObserversCount( ) > 0 ) observed += 1;
    const { data } = query.state;
    const infinitePages = ( data as { pages?: unknown[] } | undefined )?.pages;
    if ( Array.isArray( infinitePages ) ) {
      pages += infinitePages.length;
      infinitePages.forEach( page => { results += resultsLength( page ); } );
    } else if ( Array.isArray( data ) ) {
      results += data.length;
    } else {
      results += resultsLength( data );
    }
  } );
  return {
    queries: queries.length, observed, pages, results,
  };
};

const currentContext = ( ): MemoryContext => ( {
  ...contexts,
  js: jsHeap( ),
  queryCache: queryCacheCounts( ),
  // Audio ID keeps the app running in the background, where nothing else on
  // the trail is on screen
  appState: AppState.currentState,
  screen,
  trail: trail.join( " > " ),
} );

const logJump = async (
  stats: MemoryStats,
  previous: NonNullable<typeof lastSample>,
  counters: MemoryCounters | null,
  now: number,
) => {
  const grewMB = stats.footprintMB - previous.footprintMB;
  if ( grewMB < JUMP_MB || now - previous.at > JUMP_MAX_GAP_MS ) return;
  if ( now - lastJumpAt < JUMP_MIN_INTERVAL_MS || jumpsLogged >= MAX_JUMPS_LOGGED ) return;
  lastJumpAt = now;
  jumpsLogged += 1;
  const snapshot = await ImageCropper?.memorySnapshot?.( null ).catch( ( ) => null );
  logger.warnWithExtra( "memory_jump", {
    ...stats,
    ...currentContext( ),
    grewMB,
    overS: Math.round( ( now - previous.at ) / 100 ) / 10,
    counters,
    counterChanges: counterChanges( previous.counters, counters ),
    snapshot,
  } );
};

const sample = async ( ): Promise<number | null> => {
  const stats = await memoryStats( )?.catch( ( ) => null );
  if ( !stats || stats.footprintMB < 0 ) return null;
  const { footprintMB } = stats;
  const now = Date.now( );
  const counters = await ImageCropper?.memoryCounters?.( ).catch( ( ) => null ) ?? null;
  const previous = lastSample;
  lastSample = { footprintMB, at: now, counters };
  if ( previous ) await logJump( stats, previous, counters, now );
  const high = footprintMB >= FIRST_STEP_MB;
  // Keep the on-disk snapshot no more than PERSIST_MS old while high, and
  // overwrite it once when the footprint comes back down, so the next launch
  // only reports a session that ended high
  const persist = ( high && now - persistedAt >= PERSIST_MS ) || ( !high && persistedHigh );
  const step = footprintMB < FIRST_STEP_MB
    ? 0
    : FIRST_STEP_MB + Math.floor( ( footprintMB - FIRST_STEP_MB ) / STEP_MB ) * STEP_MB;
  const newStep = step > highestStepLogged;
  if ( !persist && !newStep ) return footprintMB;

  const context = currentContext( );
  if ( persist ) {
    persistedAt = now;
    persistedHigh = high;
  }
  const snapshot = await ImageCropper?.memorySnapshot?.( persist
    ? context
    : null ).catch( ( ) => null );
  if ( newStep ) {
    highestStepLogged = step;
    logger.warnWithExtra( "memory_high_water", {
      ...stats,
      ...context,
      snapshot,
    } );
  }
  return footprintMB;
};

export const noteScreenMemory = ( screenName?: string ) => {
  if ( !screenName || screenName === screen ) return;
  screen = screenName;
  memoryStats( )?.then( ( { footprintMB } ) => {
    trail.push( `${screenName}:${footprintMB}` );
    if ( trail.length > TRAIL_LENGTH ) trail.shift( );
  } ).then( sample ).catch( ( ) => null );
};

// The previous launch's last snapshot, if it ended with the footprint high:
// most likely an out-of-memory kill, which leaves nothing else in the log.
const logPreviousLaunch = async ( ) => {
  const previous = await ImageCropper?.takePreviousMemorySnapshot?.( ).catch( ( ) => null );
  if ( !previous || previous.footprintMB < HIGH_MB ) return;
  logger.warnWithExtra( "previous_launch_ended_high_memory", {
    ...previous,
    snapshotAgeAtLaunchS: previous.at
      ? Math.round( ( Date.now( ) - previous.at ) / 1000 )
      : null,
  } );
};

export const startMemoryWatermark = ( ) => {
  if ( started || !ImageCropper?.memoryStats ) return;
  started = true;
  logPreviousLaunch( );
  // In the background too: timers only run there while Audio ID keeps the app
  // awake, and the Nov 20 kill climbed to the limit with it listening in the
  // background, unsampled until the app was reopened seconds before it died.
  const loop = async ( ) => {
    const footprintMB = await sample( ).catch( ( ) => null );
    setTimeout( loop, footprintMB != null && footprintMB >= HIGH_MB
      ? HIGH_SAMPLE_MS
      : SAMPLE_MS );
  };
  setTimeout( loop, SAMPLE_MS );
};
