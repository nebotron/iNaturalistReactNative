import { AppState } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "realmWriteStats" );

// Realm write transactions by description, logged as one realm_write_summary
// line at most every SUMMARY_INTERVAL_MS. MetricKit reports disk writes per
// screen (Suggestions 272 MB/min, PhotoLibrary 262, ImageCropEditor 151, Nov
// 21-27) but not what wrote them, and the CPU profiles spend ~3% of JS samples
// in Realm_begin/commit_transaction without saying whose. A label with many
// commits is a candidate for batching; one with a high ms total is a candidate
// for skipping unchanged writes.
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000;
const TOP_LABELS = 12;

interface Tally { n: number; ms: number; maxMs: number }

let tallies = new Map<string, Tally>( );
let windowStart = Date.now( );

export const flushRealmWriteStats = ( now = Date.now( ) ) => {
  if ( tallies.size === 0 ) {
    windowStart = now;
    return;
  }
  let commits = 0;
  let totalMs = 0;
  tallies.forEach( tally => {
    commits += tally.n;
    totalMs += tally.ms;
  } );
  const top = [...tallies.entries( )]
    .sort( ( a, b ) => b[1].ms - a[1].ms || b[1].n - a[1].n )
    .slice( 0, TOP_LABELS )
    .map( ( [label, { n, ms, maxMs }] ) => [label, {
      n, ms: Math.round( ms ), maxMs: Math.round( maxMs ),
    }] );
  logger.infoWithExtra( "realm_write_summary", {
    windowSec: Math.round( ( now - windowStart ) / 1000 ),
    commits,
    totalMs: Math.round( totalMs ),
    labels: tallies.size,
    byLabel: JSON.stringify( Object.fromEntries( top ) ),
  } );
  tallies = new Map( );
  windowStart = now;
};

export const recordRealmWrite = ( description: string, ms: number, now = Date.now( ) ) => {
  const tally = tallies.get( description ) ?? { n: 0, ms: 0, maxMs: 0 };
  tally.n += 1;
  tally.ms += ms;
  tally.maxMs = Math.max( tally.maxMs, ms );
  tallies.set( description, tally );
  if ( now - windowStart >= SUMMARY_INTERVAL_MS ) flushRealmWriteStats( now );
};

// Backgrounding may be the last chance before the process is killed
AppState.addEventListener( "change", state => {
  if ( state === "background" ) flushRealmWriteStats( );
} );
