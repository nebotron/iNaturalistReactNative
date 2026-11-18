import { AppState, NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "memoryWatermark" );

// iOS kills the app for memory without anything reaching the log. The Nov 18
// kill came in the crop editor with the footprint already at 2.6GB when it
// opened, and nothing said which screen had taken it there. So log the screens
// visited, with the footprint on each, whenever the footprint reaches a new
// step (1.5GB, 2GB, ...): once per step per launch, so only heavy sessions log.
const FIRST_STEP_MB = 1536;
const STEP_MB = 512;
// Sampled between screen changes too, since memory also grows within one
// screen (a bulk crop, a scrolling grid).
const SAMPLE_MS = 10_000;
const TRAIL_LENGTH = 10;

interface MemoryStats { footprintMB: number; freeMB: number }

// iOS only; elsewhere there is nothing to sample and this all does nothing.
const { ImageCropper } = NativeModules as {
  ImageCropper?: { memoryStats?: ( ) => Promise<MemoryStats> };
};
const memoryStats = ( ): Promise<MemoryStats> | null => ImageCropper?.memoryStats?.( ) ?? null;

let screen = "unknown";
// "Screen:footprintMB" for the screens visited, oldest first.
const trail: string[] = [];
let highestStepLogged = 0;
let started = false;

const sample = async ( ) => {
  const stats = await memoryStats( )?.catch( ( ) => null );
  if ( !stats || stats.footprintMB < 0 ) return;
  const { footprintMB, freeMB } = stats;
  const step = footprintMB < FIRST_STEP_MB
    ? 0
    : FIRST_STEP_MB + Math.floor( ( footprintMB - FIRST_STEP_MB ) / STEP_MB ) * STEP_MB;
  if ( step <= highestStepLogged ) return;
  highestStepLogged = step;
  logger.warnWithExtra( "memory_high_water", {
    footprintMB,
    freeMB,
    screen,
    trail: trail.join( " > " ),
  } );
};

export const noteScreenMemory = ( screenName?: string ) => {
  if ( !screenName || screenName === screen ) return;
  screen = screenName;
  memoryStats( )?.then( ( { footprintMB } ) => {
    trail.push( `${screenName}:${footprintMB}` );
    if ( trail.length > TRAIL_LENGTH ) trail.shift( );
  } ).then( sample ).catch( ( ) => null );
};

export const startMemoryWatermark = ( ) => {
  if ( started || !ImageCropper?.memoryStats ) return;
  started = true;
  setInterval( ( ) => {
    if ( AppState.currentState === "active" ) sample( );
  }, SAMPLE_MS );
};
