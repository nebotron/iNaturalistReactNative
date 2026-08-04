import type { Query, QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";
import { getCurrentRoute } from "navigation/navigationUtils";
import { AppState } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "slowLoadTracker" );

// uiDelayTracker covers the delays the JS thread causes; this covers the other
// half of what a user experiences as slowness: a screen that rendered on time
// and then sat on a spinner waiting for data.

// Past this the user has been watching a loading state rather than a blink.
const SLOW_FETCH_MS = 5_000;
// A fetch still running this long after it started is reported as a hang
// rather than waited on, because it may never resolve.
const HANG_FETCH_MS = 20_000;
// How often in-flight fetches are checked against HANG_FETCH_MS.
const HANG_SWEEP_MS = 5_000;
// One slow fetch is a signal; a dozen in the same second are one signal
// repeated. When the network stalls, every query a screen has in flight
// crosses SLOW_FETCH_MS together — the Aug 4 log carried 100 of these lines
// inside 19 minutes (a third of the whole log), seven of them within 7ms of
// each other, and all 92 of the slow_query ones had status "success". Collect
// what lands in a window and report the burst once.
const BURST_WINDOW_MS = 5_000;
// A burst's query and screen names go out as one string; enough of them to
// see what stalled, not the whole cache.
const BURST_NAME_LIMIT = 10;

interface PendingFetch {
  startedAt: number;
  label: string;
  screen: string;
  hangLogged: boolean;
}

const pending = new Map<string, PendingFetch>( );
let sweep: ReturnType<typeof setInterval> | null = null;
let unsubscribe: ( ( ) => void ) | null = null;
let appStateSubscription: { remove: ( ) => void } | null = null;
// Time spent while the app wasn't in the foreground isn't time the user spent
// waiting, and iOS suspends in-flight work anyway.
let lastNonActiveAt = 0;

const currentScreen = ( ): string => getCurrentRoute( )?.name ?? "unknown";

interface SlowReport {
  query: string;
  elapsedMs: number;
  screen: string;
  status: string;
  hang: boolean;
}

let burst: SlowReport[] = [];
let burstTimer: ReturnType<typeof setTimeout> | null = null;

const distinctNames = ( values: string[] ): string => {
  const unique = [...new Set( values )];
  return unique.length > BURST_NAME_LIMIT
    ? `${unique.slice( 0, BURST_NAME_LIMIT ).join( "," )},+${unique.length - BURST_NAME_LIMIT}`
    : unique.join( "," );
};

const flushBurst = ( ) => {
  burstTimer = null;
  const reports = burst;
  burst = [];
  if ( reports.length === 0 ) return;
  // A lone slow fetch is the case worth reading in full, so it keeps its own
  // marker and fields; only an actual burst is summarised.
  if ( reports.length === 1 ) {
    const [only] = reports;
    if ( only.hang ) {
      logger.infoWithExtra( "query_hang", {
        query: only.query,
        elapsedMs: only.elapsedMs,
        screen: only.screen,
      } );
    } else {
      logger.infoWithExtra( "slow_query", {
        query: only.query,
        elapsedMs: only.elapsedMs,
        status: only.status,
        screen: only.screen,
      } );
    }
    return;
  }
  const elapsed = reports.map( report => report.elapsedMs ).sort( ( a, b ) => a - b );
  logger.infoWithExtra( "slow_query_burst", {
    count: reports.length,
    hangs: reports.filter( report => report.hang ).length,
    errors: reports.filter( report => report.status === "error" ).length,
    medianMs: elapsed[Math.floor( elapsed.length / 2 )],
    maxMs: elapsed[elapsed.length - 1],
    queries: distinctNames( reports.map( report => report.query ) ),
    screens: distinctNames( reports.map( report => report.screen ) ),
  } );
};

const reportSlow = ( entry: SlowReport ) => {
  burst.push( entry );
  if ( !burstTimer ) { burstTimer = setTimeout( flushBurst, BURST_WINDOW_MS ); }
};

// Query keys start with the name of the thing being fetched and continue with
// ids, photo URIs and filter objects. Only the leading names are useful in a
// log line, and only they are safe to record: filtering on "is a string" alone
// let a key like ["scoreImage", "file:///…/photo.jpg"] carry a photo path into
// the shared log, and gave every photo its own label to boot.
const QUERY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

const queryLabel = ( queryKey: unknown ): string => {
  if ( !Array.isArray( queryKey ) ) return "unknown";
  const named: string[] = [];
  for ( const key of queryKey ) {
    // Stop at the first element that isn't a plain name: everything past it is
    // an id or a filter, not part of what to call this query.
    if ( typeof key !== "string" || !QUERY_NAME.test( key ) || UUID_PREFIX.test( key ) ) break;
    named.push( key );
    if ( named.length === 2 ) break;
  }
  return named.join( "/" ) || "unknown";
};

// Only fetches something on screen is waiting on are user-visible delays;
// prefetches and background refetches with no observer aren't.
const hasObservers = ( query: Query ): boolean => (
  typeof query.getObserversCount === "function"
    ? query.getObserversCount( ) > 0
    : true
);

const startPending = ( query: Query ) => {
  if ( pending.has( query.queryHash ) || !hasObservers( query ) ) return;
  pending.set( query.queryHash, {
    startedAt: Date.now( ),
    label: queryLabel( query.queryKey ),
    screen: currentScreen( ),
    hangLogged: false,
  } );
};

const finishPending = ( query: Query, status: string ) => {
  const entry = pending.get( query.queryHash );
  if ( !entry ) return;
  pending.delete( query.queryHash );
  // Already reported while it was still running; don't log it twice.
  if ( entry.hangLogged ) return;

  const elapsedMs = Date.now( ) - entry.startedAt;
  if ( elapsedMs < SLOW_FETCH_MS ) return;
  if ( lastNonActiveAt >= entry.startedAt ) return;

  reportSlow( {
    query: entry.label,
    elapsedMs,
    status,
    // Where the wait started, which is the screen showing the spinner.
    screen: entry.screen,
    hang: false,
  } );
};

const onCacheEvent = ( event: QueryCacheNotifyEvent ) => {
  const { query } = event;
  if ( event.type === "removed" ) {
    pending.delete( query.queryHash );
    return;
  }
  if ( event.type !== "updated" ) return;

  switch ( event.action.type ) {
    case "fetch":
      startPending( query );
      break;
    case "success":
      finishPending( query, "success" );
      break;
    case "error":
      finishPending( query, "error" );
      break;
    // Offline pauses and retry backoff aren't the app being slow, and their
    // elapsed time is dominated by waiting for the network to come back.
    case "pause":
    case "failed":
      pending.delete( query.queryHash );
      break;
    default:
      break;
  }
};

const onSweep = ( ) => {
  const now = Date.now( );
  pending.forEach( entry => {
    if ( entry.hangLogged || now - entry.startedAt < HANG_FETCH_MS ) return;
    entry.hangLogged = true;
    if ( lastNonActiveAt >= entry.startedAt ) return;
    reportSlow( {
      query: entry.label,
      elapsedMs: now - entry.startedAt,
      screen: entry.screen,
      status: "pending",
      hang: true,
    } );
  } );
};

// Watches every query the UI waits on, so a screen stuck on a loading state is
// logged whether the fetch eventually finishes or never does. Safe to call more
// than once; only the first call subscribes.
export const startSlowLoadMonitoring = ( queryClient: QueryClient ) => {
  if ( unsubscribe ) return;
  unsubscribe = queryClient.getQueryCache( ).subscribe( onCacheEvent );
  appStateSubscription = AppState.addEventListener( "change", state => {
    if ( state !== "active" ) { lastNonActiveAt = Date.now( ); }
  } );
  sweep = setInterval( onSweep, HANG_SWEEP_MS );
};

export const stopSlowLoadMonitoring = ( ) => {
  unsubscribe?.( );
  unsubscribe = null;
  if ( sweep ) { clearInterval( sweep ); }
  sweep = null;
  appStateSubscription?.remove( );
  appStateSubscription = null;
  pending.clear( );
  // Report what has already been collected rather than dropping it: monitoring
  // stops on teardown, and a burst mid-window is exactly what a teardown-
  // triggering stall looks like.
  if ( burstTimer ) { clearTimeout( burstTimer ); }
  flushBurst( );
  lastNonActiveAt = 0;
};

export default startSlowLoadMonitoring;
