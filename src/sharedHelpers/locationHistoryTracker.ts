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
import distanceInMeters from "sharedHelpers/geoDistance";
import { clearWatch, watchPosition } from "sharedHelpers/geolocationWrapper";
import { store } from "sharedHelpers/installData";
import { log } from "sharedHelpers/logger";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";

const logger = log.extend( "locationHistoryTracker" );

const TRACKING_ENABLED_KEY = "locationHistoryTrackingEnabled";
const BACKGROUND_TASK_NAME = "location-history-tracking";
// Only record a new point if the user has moved this far...
const MIN_DISTANCE_METERS = 50;
// ...or this much time has passed since the last recorded point
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
} as const;

const DEFAULT_GEOLOCATION_CONFIG = {
  skipPermissionRequests: true,
} as const;

let watchId: number | null = null;
let realmInstance: Realm | null = null;
let lastRecorded: { latitude: number; longitude: number; timestamp: number } | null = null;

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

const recordPosition = async ( position: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
} ) => {
  const { latitude, longitude, accuracy } = position.coords;
  const now = Date.now();

  if ( lastRecorded ) {
    const elapsedMs = now - lastRecorded.timestamp;
    const movedMeters = distanceInMeters(
      lastRecorded.latitude,
      lastRecorded.longitude,
      latitude,
      longitude,
    );
    if ( elapsedMs < MIN_INTERVAL_MS && movedMeters < MIN_DISTANCE_METERS ) {
      return;
    }
  }
  lastRecorded = { latitude, longitude, timestamp: now };

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
  } catch ( error ) {
    logger.error( "Failed to save location history point", error );
  }
};

const backgroundTask = async ( ) => {
  await new Promise<void>( resolve => {
    watchId = watchPosition(
      recordPosition,
      error => logger.warn( "watchPosition error", error ),
      {
        enableHighAccuracy: false,
        distanceFilter: MIN_DISTANCE_METERS,
        interval: MIN_INTERVAL_MS,
        fastestInterval: MIN_INTERVAL_MS,
        useSignificantChanges: true,
      },
    );

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

const requestLocationHistoryTrackingPermissions = async ( ): Promise<boolean> => {
  const foregroundResult = await requestMultiple( LOCATION_PERMISSIONS );
  const foregroundGranted = Object.values( foregroundResult )
    .every( result => result === RESULTS.GRANTED );
  if ( !foregroundGranted ) return false;

  if ( BACKGROUND_LOCATION_PERMISSIONS.length === 0 ) return true;

  const backgroundResult = await requestMultiple( BACKGROUND_LOCATION_PERMISSIONS );
  return Object.values( backgroundResult ).every( result => result === RESULTS.GRANTED );
};

export const startLocationHistoryTracking = async ( ): Promise<boolean> => {
  try {
    const granted = await requestLocationHistoryTrackingPermissions();
    if ( !granted ) return false;

    if ( Platform.OS === "android" && !BackgroundService.isRunning( ) ) {
      await BackgroundService.start( backgroundTask, getBackgroundServiceOptions( ) );
    } else if ( Platform.OS !== "android" && watchId === null ) {
      Geolocation.setRNConfiguration( IOS_BACKGROUND_TRACKING_GEOLOCATION_CONFIG );
      watchId = watchPosition(
        recordPosition,
        error => logger.warn( "watchPosition error", error ),
        {
          enableHighAccuracy: false,
          distanceFilter: MIN_DISTANCE_METERS,
          useSignificantChanges: true,
        },
      );
      Geolocation.setRNConfiguration( DEFAULT_GEOLOCATION_CONFIG );
    }
    store.set( TRACKING_ENABLED_KEY, true );
    return true;
  } catch ( error ) {
    logger.error( "Failed to start location history tracking", error );
    return false;
  }
};

export const stopLocationHistoryTracking = async ( ) => {
  if ( watchId !== null ) {
    clearWatch( watchId );
    watchId = null;
  }
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
