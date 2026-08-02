import { getCurrentRoute } from "navigation/navigationUtils";
import { AppState } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "uiDelayTracker" );

// How often the heartbeat timer is scheduled. Whatever the JS thread spends
// beyond this between ticks is time it spent unable to answer a touch.
const HEARTBEAT_MS = 500;
// Overrun that counts as a user-visible stall rather than scheduling jitter.
const STALL_THRESHOLD_MS = 1000;
// Overruns past this are the app having been suspended (iOS stops timers when
// the app is backgrounded or the screen locks), not the JS thread blocking.
const MAX_PLAUSIBLE_STALL_MS = 30_000;
// Stalls come in bursts (one slow operation trips several ticks), so summarize
// rather than emitting a line per tick.
const STALL_LOG_INTERVAL_MS = 30_000;
// A push/pop animation is ~350ms; past this the screen was waiting on work.
const SLOW_TRANSITION_MS = 800;
// Same suspension caveat as stalls: a transition can't really take this long.
const MAX_PLAUSIBLE_TRANSITION_MS = 30_000;
// Work between a tap and the navigation it triggers is invisible to
// trackScreenTransition, whose clock can only start once navigation is asked to
// move. trackUiWork covers that gap for the handlers slow enough to need it.
const SLOW_UI_WORK_MS = 500;

let heartbeat: ReturnType<typeof setInterval> | null = null;
let appStateSubscription: { remove: ( ) => void } | null = null;
let lastTickAt = 0;
// Timers don't fire while the app is suspended, so any tick spanning a period
// when the app wasn't active measures background time, not a stall.
let activeSinceLastTick = true;
let stallsSinceLastLog = 0;
let worstStallMs = 0;
let lastStallLogAt = 0;
// When the user tapped, as opposed to when navigation state caught up.
let navigationDispatchedAt: number | null = null;

const currentScreen = ( ): string => getCurrentRoute( )?.name ?? "unknown";

const onHeartbeat = ( ) => {
  const now = Date.now( );
  const overrunMs = now - lastTickAt - HEARTBEAT_MS;
  const wasActive = activeSinceLastTick;
  lastTickAt = now;
  activeSinceLastTick = AppState.currentState === "active";

  if ( overrunMs < STALL_THRESHOLD_MS ) return;
  if ( !wasActive || overrunMs > MAX_PLAUSIBLE_STALL_MS ) return;

  stallsSinceLastLog += 1;
  worstStallMs = Math.max( worstStallMs, overrunMs );
  if ( now - lastStallLogAt < STALL_LOG_INTERVAL_MS ) return;

  lastStallLogAt = now;
  logger.infoWithExtra( "ui_stall", {
    stalledMs: Math.round( worstStallMs ),
    stallCount: stallsSinceLastLog,
    screen: currentScreen( ),
  } );
  stallsSinceLastLog = 0;
  worstStallMs = 0;
};

// Watches the JS thread for the stretches where it can't respond to touches -
// the delays a user experiences as the app freezing. Safe to call more than
// once; only the first call starts the timer.
export const startUiDelayMonitoring = ( ) => {
  if ( heartbeat ) return;
  lastTickAt = Date.now( );
  activeSinceLastTick = AppState.currentState === "active";
  appStateSubscription = AppState.addEventListener( "change", state => {
    if ( state !== "active" ) { activeSinceLastTick = false; }
  } );
  heartbeat = setInterval( onHeartbeat, HEARTBEAT_MS );
};

export const stopUiDelayMonitoring = ( ) => {
  if ( heartbeat ) { clearInterval( heartbeat ); }
  heartbeat = null;
  appStateSubscription?.remove( );
  appStateSubscription = null;
};

// Called when a navigation action is dispatched, which is the closest thing we
// have to "when the user tapped". Timing from the resulting state change
// instead would hide exactly the delay we're looking for: the work that ran
// between the tap and navigation getting a chance to act on it.
export const markNavigationDispatched = ( ) => {
  if ( navigationDispatchedAt === null ) {
    navigationDispatchedAt = Date.now( );
  }
};

// Called on every navigation state change. Logs how long the user waited
// between their tap and the new screen being done rendering, but only for the
// transitions slow enough to be worth looking at.
export const trackScreenTransition = ( {
  fromScreen,
  toScreen,
}: {
  fromScreen?: string;
  toScreen?: string;
} ) => {
  const dispatchedAt = navigationDispatchedAt;
  navigationDispatchedAt = null;
  // State changes that don't land on a new screen (params updated on the screen
  // we're already on, say) still clear the mark, so the next real transition
  // doesn't inherit a stale one and report the wait as its own.
  if ( !toScreen || toScreen === fromScreen ) return;

  const now = Date.now( );
  const startedAt = ( dispatchedAt && now - dispatchedAt < MAX_PLAUSIBLE_TRANSITION_MS )
    ? dispatchedAt
    : now;
  const stateAppliedMs = now - startedAt;

  // Idle means the JS thread has finished rendering the new screen and has
  // nothing left queued, i.e. the screen is ready to be used - the same
  // definition of "interactive" startupPerformanceTracker measures against.
  requestIdleCallback( ( ) => {
    const totalMs = Date.now( ) - startedAt;
    if ( totalMs < SLOW_TRANSITION_MS || totalMs > MAX_PLAUSIBLE_TRANSITION_MS ) return;
    logger.infoWithExtra( "slow_screen_transition", {
      fromScreen: fromScreen ?? "unknown",
      toScreen,
      // Tap to the new state being applied, which is JS-thread time the user
      // spends looking at the old screen.
      stateAppliedMs,
      // Tap to the new screen having finished rendering.
      totalMs,
    } );
  } );
};

export const trackUiWork = ( work: string, startedAt: number ) => {
  const elapsedMs = Date.now( ) - startedAt;
  if ( elapsedMs < SLOW_UI_WORK_MS ) return;
  logger.infoWithExtra( "slow_ui_work", {
    work,
    elapsedMs,
    screen: currentScreen( ),
  } );
};
