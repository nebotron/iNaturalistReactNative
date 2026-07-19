import Geolocation from "@react-native-community/geolocation";
import {
  LOCATION_PERMISSIONS,
} from "components/SharedComponents/PermissionGateContainer";
import { t } from "i18next";
import { Platform } from "react-native";
import BackgroundService from "react-native-background-actions";
import { useMMKVBoolean } from "react-native-mmkv";
import {
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

// `source` labels which watch delivered the fix (continuous vs
// significant-changes vs the Android background service) so the logs show
// whether and how the OS is actually waking the app in the background.
const recordPosition = ( source: string ) => async ( position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
} ) => {
  const { latitude, longitude, accuracy } = position.coords;
  const now = Date.now();

  // Store every fix the watch delivers. We intentionally don't thin points at
  // capture time - keeping the full history lets the interpolation phase pick
  // the most accurate fixes for a given moment (see interpolateTrackedLocation).

  try {
    const realm = await getRealmInstance();
    safeRealmWrite( realm, ( ) => {
      realm.create(
        "LocationHistoryPoint",
        LocationHistoryPoint.mapPositionToRealm( {
          latitude,
          longitude,
          accuracy,
          recordedAt: new Date( now ),
        } ),
      );
    }, "recording location history point" );
    logger.infoWithExtra( `Recorded location fix from ${source}`, { accuracy, recordedAt: now } );
  } catch ( error ) {
    logger.error( "Failed to save location history point", error );
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

const requestLocationHistoryTrackingPermissions = async ( ): Promise<StartTrackingResult> => {
  const foregroundResult = await requestMultiple( LOCATION_PERMISSIONS );
  const foregroundGranted = Object.values( foregroundResult )
    .every( result => result === RESULTS.GRANTED );
  if ( !foregroundGranted ) {
    return { success: false, reason: describePermissionResults( foregroundResult ) };
  }

  if ( BACKGROUND_LOCATION_PERMISSIONS.length === 0 ) return { success: true };

  const backgroundResult = await requestMultiple( BACKGROUND_LOCATION_PERMISSIONS );
  const backgroundGranted = Object.values( backgroundResult )
    .every( result => result === RESULTS.GRANTED );
  if ( !backgroundGranted ) {
    return { success: false, reason: describePermissionResults( backgroundResult ) };
  }
  return { success: true };
};

export const startLocationHistoryTracking = async ( ): Promise<StartTrackingResult> => {
  try {
    const permissionResult = await requestLocationHistoryTrackingPermissions();
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
    await startLocationHistoryTracking( );
  }
};
