import { getCurrentRoute } from "navigation/navigationUtils";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "uiDelayTracker" );

// A push/pop animation is ~350ms; past this the screen was waiting on work.
const SLOW_TRANSITION_MS = 800;
// Past this the app was likely suspended mid-transition rather than slow.
const MAX_PLAUSIBLE_TRANSITION_MS = 30_000;
// Work between a tap and the navigation it triggers is invisible to
// trackScreenTransition, whose clock can only start once navigation is asked to
// move. trackUiWork covers that gap for the handlers slow enough to need it.
const SLOW_UI_WORK_MS = 500;

// When the user tapped, as opposed to when navigation state caught up.
let navigationDispatchedAt: number | null = null;

const currentScreen = ( ): string => getCurrentRoute( )?.name ?? "unknown";

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
