import { AppState } from "react-native";
import type { PerformanceEntry } from "react-native-performance";
import performance from "react-native-performance";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "startupPerformanceTracker" );

export interface ScreenMeta {
  targetScreen: "MyObservations" | "OnboardingCarousel";
  loggedIn: boolean;
}

const getMark = ( name: string ): PerformanceEntry | undefined => (
  performance.getEntriesByName( name, "react-native-mark" )[0]
);

class StartupPerformanceTracker {
  private emitted: boolean;

  // screenInteractiveMs is performance.now() at the (idle-scheduled) emit time
  // minus native launch. requestIdleCallback does not run while backgrounded,
  // so if the app was ever backgrounded before we emit, that elapsed time folds
  // in hours of background/idle time and the value is meaningless. Track it so
  // we can report "NA" instead of polluting the metric.
  private backgroundedSinceLaunch: boolean;

  constructor( ) {
    this.emitted = false;
    this.backgroundedSinceLaunch = false;
    AppState.addEventListener( "change", state => {
      if ( state === "background" ) { this.backgroundedSinceLaunch = true; }
    } );
  }

  // Called from our target landing screen requestIdleCallback handlers. The emitted flag
  // ensures only the first call per cold start is logged, preventing repeated focus
  // events/warm starts from re-firing it.
  emitStartupTTI( metaData: ScreenMeta ): void {
    if ( this.emitted ) { return; }
    this.emitted = true;

    try {
      const nativeLaunchStart = getMark( "nativeLaunchStart" );
      const nativeLaunchEnd = getMark( "nativeLaunchEnd" );
      const runJsBundleStart = getMark( "runJsBundleStart" );
      const runJsBundleEnd = getMark( "runJsBundleEnd" );
      const contentAppeared = getMark( "contentAppeared" );

      // All elapsed times are relative to nativeLaunchStart so they form a
      // directly comparable timeline. "NA" if the native mark is unavailable
      const originMs = nativeLaunchStart?.startTime;

      const nativeLaunchMs = ( nativeLaunchStart && nativeLaunchEnd )
        ? Math.round( nativeLaunchEnd.startTime - nativeLaunchStart.startTime )
        : "NA";

      const jsBundleLoadedMs = ( runJsBundleStart && runJsBundleEnd )
        ? Math.round( runJsBundleEnd.startTime - runJsBundleStart.startTime )
        : "NA";

      const contentAppearedMs = ( contentAppeared && originMs !== undefined )
        ? Math.round( contentAppeared.startTime - originMs )
        : "NA";

      // performance.now() is in the same time domain as the native marks
      // (ms since performance.timeOrigin ≈ native launch). Only meaningful for
      // an uninterrupted foreground cold start — see backgroundedSinceLaunch.
      const screenInteractiveMs = ( originMs !== undefined && !this.backgroundedSinceLaunch )
        ? Math.round( performance.now() - originMs )
        : "NA";

      logger.infoWithExtra( "startup_tti", {
        screenInteractiveMs,
        contentAppearedMs,
        jsBundleLoadedMs,
        nativeLaunchMs,
        startType: "cold",
        targetScreen: metaData.targetScreen,
        loggedIn: metaData.loggedIn,
      } );
    } catch ( e ) {
      logger.error( "startup_tti collection failed", e );
    }
  }
}

const startupPerformanceTracker = new StartupPerformanceTracker( );
export default startupPerformanceTracker;
