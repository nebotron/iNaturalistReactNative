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

interface MemoryStats { footprintMB: number; freeMB: number }

type MemoryContext = Record<string, unknown>;

// iOS only; elsewhere there is nothing to sample and this all does nothing.
const { ImageCropper } = NativeModules as {
  ImageCropper?: {
    memoryStats?: ( ) => Promise<MemoryStats>;
    memorySnapshot?: ( context: MemoryContext | null ) => Promise<Record<string, unknown>>;
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

// What a feature that holds a lot of memory is doing, for the snapshots: the
// camera's photos taken, Audio ID's listening time and runs. undefined clears.
export const setMemoryContext = ( key: string, value?: MemoryContext ) => {
  if ( value ) {
    contexts[key] = value;
  } else {
    delete contexts[key];
  }
};

const currentContext = ( ): MemoryContext => ( {
  ...contexts,
  // Audio ID keeps the app running in the background, where nothing else on
  // the trail is on screen
  appState: AppState.currentState,
  screen,
  trail: trail.join( " > " ),
} );

const sample = async ( ): Promise<number | null> => {
  const stats = await memoryStats( )?.catch( ( ) => null );
  if ( !stats || stats.footprintMB < 0 ) return null;
  const { footprintMB } = stats;
  const now = Date.now( );
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
