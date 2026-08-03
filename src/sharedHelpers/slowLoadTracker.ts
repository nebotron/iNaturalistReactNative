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

// Query keys start with the name of the thing being fetched and continue with
// ids, photo URIs and filter objects. Only the leading strings are useful in a
// log line, and only they are safe to record.
const queryLabel = ( queryKey: unknown ): string => {
  if ( !Array.isArray( queryKey ) ) return "unknown";
  const named = queryKey.filter( key => typeof key === "string" ).slice( 0, 2 );
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

  logger.infoWithExtra( "slow_query", {
    query: entry.label,
    elapsedMs,
    status,
    // Where the wait started, which is the screen showing the spinner.
    screen: entry.screen,
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
    logger.infoWithExtra( "query_hang", {
      query: entry.label,
      elapsedMs: now - entry.startedAt,
      screen: entry.screen,
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
  lastNonActiveAt = 0;
};

export default startSlowLoadMonitoring;
