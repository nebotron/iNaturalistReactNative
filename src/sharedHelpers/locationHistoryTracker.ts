import Geolocation from "@react-native-community/geolocation";
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
import { log, logWithoutRemote } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const logger = log.extend( "locationHistoryTracker" );
// Per-fix breadcrumbs fire on every GPS tick (the single largest remote-log
// source after button taps): useful in a device log, not worth a remote POST
// each. Errors/warns still go through `logger` so they reach Firebase.
const breadcrumbLogger = logWithoutRemote.extend( "locationHistoryTracker" );

const TRACKING_ENABLED_KEY = "locationHistoryTrackingEnabled";
const BACKGROUND_TASK_NAME = "location-history-tracking";
// The OS only delivers a new fix once the user has moved this far (the watch's
// distanceFilter), which keeps background tracking power-efficient. Every fix
// it does deliver is stored; accuracy filtering happens at interpolation time.
const MIN_DISTANCE_METERS = 50;
// Requested update interval for the Android background watch
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const POLL_MS = 1000;

const usesAndroidBackgroundLocationPermission = Platform.OS === "android" && Platform.Version >= 29;

const getBackgroundLocationPermissions = ( ) => {
  if ( Platform.OS === "ios" ) return [PERMISSIONS.IOS.LOCATION_ALWAYS];
  if ( usesAndroidBackgroundLocationPermission ) {
    return [PERMISSIONS.ANDROID.ACCESS_BACKGROUND_LOCATION];
  }
  return [];
};

const BACKGROUND_LOCATION_PERMISSIONS = getBackgroundLocationPermissions();

// @react-native-community/geolocation only calls the native code that flips
// on CLLocationManager's allowsBackgroundLocationUpdates (required for
// updates to keep arriving once the app is backgrounded) when it's the one
// driving the authorization request, i.e. skipPermissionRequests must be
// false and authorizationLevel must be explicitly "always". The rest of the
// app relies on manually-gated permission prompts, so this config is only
// switched on for the moment we start our own watch, then switched back.
const IOS_BACKGROUND_TRACKING_GEOLOCATION_CONFIG = {
  skipPermissionRequests: false,
  authorizationLevel: "always",
  // Keep CLLocationManager.allowsBackgroundLocationUpdates on so the
  // continuous watch keeps delivering fixes while the app is backgrounded.
  enableBackgroundLocationUpdates: true,
} as const;

const DEFAULT_GEOLOCATION_CONFIG = {
  skipPermissionRequests: true,
  // Preserve background updates when we flip the config back, otherwise the
  // continuous watch we just started would stop firing in the background.
  enableBackgroundLocationUpdates: true,
} as const;

// iOS-only native significant-location-change monitor. It runs its own
// CLLocationManager alongside the continuous watch so iOS relaunches the app
// after terminating it in the background - a standard-location watch can't do
// that, which is the cause of the multi-hour gaps in the tracked history. Fixes
// it captures while JS is down are buffered natively and drained on startup.
interface LocationRelaunchModule {
  start: ( ) => void;
  stop: ( ) => void;
  drainPendingLocations: ( ) => Promise<Array<{
    latitude: number;
    longitude: number;
    accuracy: number | null;
    timestamp: number;
  }>>;
}

const locationRelaunch = ( NativeModules as {
  LocationRelaunch?: LocationRelaunchModule;
} ).LocationRelaunch;

let watchIds: number[] = [];
let realmInstance: Realm | null = null;

const sleep = ( ms: number ) => new Promise<void>( resolve => {
  setTimeout( resolve, ms );
} );

export const isLocationHistoryTrackingEnabled = ( ) => (
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
// `source` labels which watch delivered the fix (continuous vs
// significant-changes vs the Android background service) so the logs show
// whether and how the OS is actually waking the app in the background.
const recordFix = async ( source: string, fix: {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: Date;
} ) => {
  try {
    const realm = await getRealmInstance();
    safeRealmWrite( realm, ( ) => {
      realm.create(
        "LocationHistoryPoint",
        LocationHistoryPoint.mapPositionToRealm( fix ),
      );
    }, "recording location history point" );
    breadcrumbLogger.info( `Recorded location fix from ${source} (accuracy ${fix.accuracy})` );
  } catch ( error ) {
    logger.error( "Failed to save location history point", error );
  }
};

const recordPosition = ( source: string ) => async ( position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
} ) => {
  const { latitude, longitude, accuracy } = position.coords;
  await recordFix( source, {
    latitude, longitude, accuracy, recordedAt: new Date(),
  } );
};

// Drain any significant-change fixes the native monitor buffered while JS was
// down (e.g. after iOS terminated and later relaunched the app) and store them
// with their original timestamps so the gap gets backfilled.
const recordPendingSignificantChanges = async ( ) => {
  if ( !locationRelaunch?.drainPendingLocations ) return;
  try {
    const pending = await locationRelaunch.drainPendingLocations();
    for ( const fix of pending ) {
      // eslint-disable-next-line no-await-in-loop
      await recordFix( "ios-significant", {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy,
        recordedAt: new Date( fix.timestamp ),
      } );
    }
  } catch ( error ) {
    logger.warn( "Failed to drain pending significant-change locations", error );
  }
};

const backgroundTask = async ( ) => {
  await new Promise<void>( resolve => {
    watchIds = [watchPosition(
      recordPosition( "android-background" ),
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
    } else if ( Platform.OS !== "android" && watchIds.length === 0 ) {
      Geolocation.setRNConfiguration( IOS_BACKGROUND_TRACKING_GEOLOCATION_CONFIG );
      // iOS background tracking uses a single continuous high-accuracy watch.
      // @react-native-community/geolocation drives one shared CLLocationManager
      // and only applies the *first* watchPosition's options (later watches just
      // attach extra callbacks), so pairing this with a second "significant
      // changes" watch would never actually start significant-change monitoring -
      // it would only record the continuous fixes twice. Instead we keep the
      // continuous watch delivering in the background via
      // allowsBackgroundLocationUpdates (enableBackgroundLocationUpdates) and,
      // crucially, pausesLocationUpdatesAutomatically = NO (see the geolocation
      // patch). Without that, iOS pauses updates whenever it thinks the user is
      // stationary and does not resume for a long time - the main cause of long
      // gaps in the tracked location history.
      const continuousWatchId = watchPosition(
        recordPosition( "ios-continuous" ),
        error => logger.warn( "watchPosition error (continuous)", error ),
        {
          enableHighAccuracy: true,
          distanceFilter: MIN_DISTANCE_METERS,
          useSignificantChanges: false,
        },
      );
      watchIds = [continuousWatchId];
      Geolocation.setRNConfiguration( DEFAULT_GEOLOCATION_CONFIG );

      // Keep significant-change monitoring running so iOS relaunches us after
      // terminating the app in the background, then backfill anything it
      // buffered while JS was down.
      locationRelaunch?.start();
      await recordPendingSignificantChanges();
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
  locationRelaunch?.stop();
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
