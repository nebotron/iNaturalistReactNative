import { AppState } from "react-native";
import { setHttpCacheStatsListener, takeHttpCacheStats } from "sharedHelpers/httpCache";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "httpCacheStats" );

// The HTTP cache's disk reads and writes, logged as one http_cache_summary
// line at most every SUMMARY_INTERVAL_MS. MetricKit puts Explore at 41 MB/min
// of disk writes (Nov 21-27) without saying what wrote them, and the cache
// saves every JSON response it fetches. readMs and writeMs also show what
// moving the bodies off react-native-fs's base64 path (TextFile.m) saved.
const SUMMARY_INTERVAL_MS = 10 * 60 * 1000;

let windowStart = Date.now( );

export const flushHttpCacheStats = ( now = Date.now( ) ) => {
  const stats = takeHttpCacheStats( );
  const windowSec = Math.round( ( now - windowStart ) / 1000 );
  windowStart = now;
  if ( stats.read.n + stats.write.n + stats.failures === 0 ) return;
  logger.infoWithExtra( "http_cache_summary", {
    windowSec,
    ...stats,
  } );
};

const onCacheIO = ( ) => {
  if ( Date.now( ) - windowStart >= SUMMARY_INTERVAL_MS ) flushHttpCacheStats( );
};

export const startHttpCacheStats = ( ) => {
  windowStart = Date.now( );
  setHttpCacheStatsListener( onCacheIO );
  // Backgrounding may be the last chance before the process is killed
  AppState.addEventListener( "change", state => {
    if ( state === "background" ) flushHttpCacheStats( );
  } );
};
