import {
  LOCATION_PERMISSIONS,
} from "components/SharedComponents/PermissionGateContainer";
import { t } from "i18next";
import { NativeModules, Platform } from "react-native";
import BackgroundService from "react-native-background-actions";
import { useMMKVBoolean } from "react-native-mmkv";
import {
  checkMultiple,
  PERMISSIONS,
  requestMultiple,
  RESULTS,
} from "react-native-permissions";
import Realm from "realm";
import realmConfig from "realmModels/index";
import LocationHistoryPoint from "realmModels/LocationHistoryPoint";
import { clearWatch, watchPosition } from "sharedHelpers/geolocationWrapper";
import { store } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const logger = log.extend( "locationHistoryTracker" );

const TRACKING_ENABLED_KEY = "locationHistoryTrackingEnabled";
const BACKGROUND_TASK_NAME = "location-history-tracking";
// The OS only delivers a new fix once the user has moved this far (the watch's
// distanceFilter), which keeps background tracking power-efficient. Every fix
// it does deliver is stored; accuracy filtering happens at interpolation time.
const MIN_DISTANCE_METERS = 50;
// Requested update interval for the Android background watch
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const POLL_MS = 1000;
// How often JS pulls the fixes the iOS native monitor has buffered into Realm
const DRAIN_INTERVAL_MS = 60 * 1000;

const usesAndroidBackgroundLocationPermission = Platform.OS === "android" && Platform.Version >= 29;

const getBackgroundLocationPermissions = ( ) => {
  if ( Platform.OS === "ios" ) return [PERMISSIONS.IOS.LOCATION_ALWAYS];
  if ( usesAndroidBackgroundLocationPermission ) {
    return [PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION];
  }
  return [];
};

const BACKGROUND_LOCATION_PERMISSIONS = getBackgroundLocationPermissions();

// iOS-only native location monitor. It owns its own CLLocationManager, tuned
// for continuous background tracking, and buffers every fix it receives (see
// LocationRelaunch.h). We deliberately don't use
// @react-native-community/geolocation for iOS background tracking: it drives a
// single shared CLLocationManager for the whole app, and its one-shot
// getCurrentPosition path stops the running watch without ever restarting it
// (`[self startObserving]` resolves to RCTEventEmitter's no-op), so the first
// foreground geotag after tracking started silently killed the watch for the
// rest of the session.
interface LocationRelaunchModule {
  start: ( ) => void;
  stop: ( ) => void;
  drainPendingLocations: ( ) => Promise<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
    timestamp: number;
  }[]>;
}

const locationRelaunch = ( NativeModules as {
  LocationRelaunch?: LocationRelaunchModule;
} ).LocationRelaunch;

let watchIds: number[] = [];
let realmInstance: Realm | null = null;
let drainInterval: ReturnType<typeof setInterval> | null = null;

const sleep = ( ms: number ) => new Promise<void>( resolve => {
  setTimeout( resolve, ms );
} );

const isLocationHistoryTrackingEnabled = ( ) => (
  store.getBoolean( TRACKING_ENABLED_KEY ) ?? false
);

export const useLocationHistoryTrackingEnabled = ( ) => (
  useMMKVBoolean( TRACKING_ENABLED_KEY, store )
);

const getRealmInstance = async ( ): Promise<Realm> => {
  if ( !realmInstance || realmInstance.isClosed ) {
    realmInstance = await Realm.open( realmConfig );
  }
  return realmInstance;
};

// Store every fix a watch delivers. We intentionally don't thin points at
// capture time - keeping the full history lets the interpolation phase pick the
// most accurate fixes for a given moment (see interpolateTrackedLocation).
const recordFixes = async ( fixes: {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: Date;
}[], intoRealm?: Realm ) => {
  if ( fixes.length === 0 ) return;
  try {
    // Writing through the caller's Realm when there is one means the points are
    // visible to it immediately, without waiting for our own instance's write
    // to propagate.
    const realm = intoRealm ?? await getRealmInstance();
    safeRealmWrite( realm, ( ) => {
      fixes.forEach( fix => realm.create(
        "LocationHistoryPoint",
        LocationHistoryPoint.mapPositionToRealm( fix ),
      ) );
    }, "recording location history points" );
  } catch ( error ) {
    logger.error( "Failed to save location history points", error );
  }
};

const recordPosition = ( ) => async ( position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
} ) => {
  const { latitude, longitude, accuracy } = position.coords;
  await recordFixes( [{
    latitude, longitude, accuracy, recordedAt: new Date(),
  }] );
};

// Move the fixes the native monitor has buffered into Realm, keeping their
// original timestamps. This is the only path by which iOS fixes get recorded,
// so it runs both on startup (backfilling anything captured while JS was down,
// e.g. after iOS terminated and later relaunched the app) and periodically
// while tracking is on.
const drainPendingFixes = async ( intoRealm?: Realm ) => {
  if ( !locationRelaunch?.drainPendingLocations ) return;
  try {
    const pending = await locationRelaunch.drainPendingLocations();
    await recordFixes( pending.map( fix => ( {
      latitude: fix.latitude,
      longitude: fix.longitude,
      accuracy: fix.accuracy,
      recordedAt: new Date( fix.timestamp ),
    } ) ), intoRealm );
  } catch ( error ) {
    logger.warn( "Failed to drain pending locations", error );
  }
};

// Lets callers that are about to read the history (e.g. geotagging a photo the
// user just took) pull in the newest fixes rather than waiting for the timer.
export const drainTrackedLocationFixes = drainPendingFixes;

const startDraining = ( ) => {
  if ( drainInterval ) return;
  drainInterval = setInterval( ( ) => {
    drainPendingFixes( );
  }, DRAIN_INTERVAL_MS );
};

const stopDraining = ( ) => {
  if ( !drainInterval ) return;
  clearInterval( drainInterval );
  drainInterval = null;
};

const backgroundTask = async ( ) => {
  await new Promise<void>( resolve => {
    watchIds = [watchPosition(
      recordPosition( ),
      error => logger.warn( "watchPosition error", error ),
      {
        enableHighAccuracy: true,
        distanceFilter: MIN_DISTANCE_METERS,
        interval: MIN_INTERVAL_MS,
        fastestInterval: MIN_INTERVAL_MS,
        useSignificantChanges: true,
      },
    )];

    const keepJsAlive = async ( ) => {
      while ( BackgroundService.isRunning( ) ) {
        // eslint-disable-next-line no-await-in-loop
        await sleep( POLL_MS );
      }
      resolve( );
    };
    keepJsAlive( );
  } );
};

const getBackgroundServiceOptions = ( ) => ( {
  taskName: BACKGROUND_TASK_NAME,
  taskTitle: t( "Tracking-your-location" ),
  taskDesc: t( "Location-history-lets-you-compare-photos-to-your-tracked-location" ),
  taskIcon: {
    name: "ic_launcher",
    type: "mipmap",
  },
  color: "#74ac00",
  foregroundServiceType: ["location"],
  parameters: {},
} );

export interface StartTrackingResult {
  success: boolean;
  // Human-readable diagnostic detail, only set when success is false
  reason?: string;
}

const describePermissionResults = ( results: Record<string, string> ): string => (
  Object.entries( results )
    .map( ( [permission, status] ) => `${permission}: ${status}` )
    .join( ", " )
);

// When resuming, we only *check* permissions rather than request them. Resume
// runs on every launch, including the background relaunches iOS triggers via
// the significant-change monitor - and a permission *request* can't present UI
// in the background, so `requestMultiple` never resolves as granted there. That
// would leave the continuous watch dead after the first background termination,
// so only the sparse significant-change fixes get recorded: large gaps in the
// history even while the user is actively moving. Permissions were already
// granted when the user first enabled tracking, so a non-blocking check is all
// the resume path needs.
const resolvePermissions = ( mode: "request" | "check" ) => (
  mode === "request"
    ? requestMultiple
    : checkMultiple
);

const ensureLocationHistoryTrackingPermissions = async (
  mode: "request" | "check",
): Promise<StartTrackingResult> => {
  const resolve = resolvePermissions( mode );
  const foregroundResult = await resolve( LOCATION_PERMISSIONS );
  const foregroundGranted = Object.values( foregroundResult )
    .every( result => result === RESULTS.GRANTED );
  if ( !foregroundGranted ) {
    return { success: false, reason: describePermissionResults( foregroundResult ) };
  }

  if ( BACKGROUND_LOCATION_PERMISSIONS.length === 0 ) return { success: true };

  const backgroundResult = await resolve( BACKGROUND_LOCATION_PERMISSIONS );
  const backgroundGranted = Object.values( backgroundResult )
    .every( result => result === RESULTS.GRANTED );
  if ( !backgroundGranted ) {
    return { success: false, reason: describePermissionResults( backgroundResult ) };
  }
  return { success: true };
};

export const startLocationHistoryTracking = async (
  { requestPermissions = true }: { requestPermissions?: boolean } = {},
): Promise<StartTrackingResult> => {
  try {
    const permissionResult = await ensureLocationHistoryTrackingPermissions(
      requestPermissions
        ? "request"
        : "check",
    );
    if ( !permissionResult.success ) {
      logger.warn( "Location history tracking permissions not granted", permissionResult.reason );
      return permissionResult;
    }

    if ( Platform.OS === "android" && !BackgroundService.isRunning( ) ) {
      await BackgroundService.start( backgroundTask, getBackgroundServiceOptions( ) );
    } else if ( Platform.OS !== "android" ) {
      // The native monitor runs both the continuous background watch and
      // significant-change monitoring (so iOS relaunches us after terminating
      // the app), buffering every fix. Backfill whatever it captured while JS
      // was down, then keep pulling new fixes into Realm.
      locationRelaunch?.start();
      await drainPendingFixes();
      startDraining();
    }
    store.set( TRACKING_ENABLED_KEY, true );
    return { success: true };
  } catch ( error ) {
    logger.error( "Failed to start location history tracking", error );
    const reason = error instanceof Error
      ? error.message
      : String( error );
    return { success: false, reason };
  }
};

export const stopLocationHistoryTracking = async ( ) => {
  watchIds.forEach( clearWatch );
  watchIds = [];
  stopDraining( );
  locationRelaunch?.stop();
  // Anything already captured still belongs in the history
  await drainPendingFixes( );
  if ( BackgroundService.isRunning( ) ) {
    try {
      await BackgroundService.stop( );
    } catch {
      // Ignore stop failures when the service is already shutting down.
    }
  }
  store.set( TRACKING_ENABLED_KEY, false );
};

// Resumes tracking on app launch if the user had previously enabled it
export const resumeLocationHistoryTrackingIfEnabled = async ( ) => {
  if ( isLocationHistoryTrackingEnabled( ) ) {
    // Resume can run in the background (iOS significant-change relaunch), where
    // permissions can only be checked, not requested. See
    // ensureLocationHistoryTrackingPermissions.
    await startLocationHistoryTracking( { requestPermissions: false } );
  }
};
