// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import type { GeolocationResponse } from "@react-native-community/geolocation";

import {
  checkLocationPermissions,
  clearWatch,
  getCurrentPositionWithOptions,
  lowAccuracyOptions,
  watchPosition,
} from "./geolocationWrapper";

interface UserLocation {
  latitude: number;
  longitude: number;
  positional_accuracy: number;
  altitude: number | null;
  altitudinal_accuracy: number | null;
}

// Meters. Once a fix this accurate arrives we stop waiting and use it.
const TARGET_POSITIONAL_ACCURACY = 10;
// How long to keep collecting fixes before giving up and using the best one
// we've seen. A single getCurrentPosition reading is often a cold GPS or
// cell/WiFi fix that can be kilometers off; watching for a few seconds lets the
// GPS converge on the real location.
const MAX_WATCH_MS = 10_000;
// Ignore fixes older than this so we never return a stale cached position.
const MAX_POSITION_AGE_MS = 60_000;

const highAccuracyWatchOptions = {
  distanceFilter: 0,
  enableHighAccuracy: true,
  maximumAge: 0,
};

const positionToUserLocation = ( position: GeolocationResponse ): UserLocation => ( {
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
  positional_accuracy: position.coords.accuracy,
  altitude: position.coords.altitude,
  altitudinal_accuracy: position.coords.altitudeAccuracy,
} );

// Watch position for a short window and resolve with the most accurate fix
// seen, returning early as soon as we reach the target accuracy. This mirrors
// what useWatchPosition does for screens that can watch continuously, so a
// synchronous capture (e.g. tapping the shutter) gets a converged fix instead
// of the first, frequently-inaccurate reading.
const watchForBestFix = ( ): Promise<GeolocationResponse | null> => new Promise( resolve => {
  let bestPosition: GeolocationResponse | null = null;
  let watchID: number | null = null;
  let timeoutID: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const finish = ( ) => {
    if ( settled ) return;
    settled = true;
    if ( timeoutID ) clearTimeout( timeoutID );
    if ( watchID !== null ) clearWatch( watchID );
    resolve( bestPosition );
  };

  const success = ( position: GeolocationResponse ) => {
    const age = Date.now( ) - position.timestamp;
    if ( age > MAX_POSITION_AGE_MS ) return;
    // A fix with no (or non-positive) accuracy can't be compared, so ignore it.
    const accuracy = position?.coords?.accuracy;
    if ( typeof accuracy !== "number" || accuracy <= 0 ) return;
    const bestAccuracy = bestPosition?.coords?.accuracy;
    if ( !bestPosition || accuracy < bestAccuracy ) {
      bestPosition = position;
    }
    if ( accuracy <= TARGET_POSITIONAL_ACCURACY ) finish( );
  };

  const failure = ( ) => finish( );

  timeoutID = setTimeout( finish, MAX_WATCH_MS );

  try {
    watchID = watchPosition( success, failure, highAccuracyWatchOptions );
    if ( typeof watchID !== "number" ) finish( );
  } catch {
    finish( );
  }
} );

const fetchAccurateUserLocation = async ( ): Promise<UserLocation | null> => {
  const permissionResult = await checkLocationPermissions( );
  if ( permissionResult === null ) {
    return null;
  }

  try {
    const bestPosition = await watchForBestFix( );
    if ( bestPosition ) {
      return positionToUserLocation( bestPosition );
    }

    // Only if watching produced no usable fix do we fall back to a single
    // low-accuracy (network/cell) reading, so we at least return an approximate
    // location rather than nothing.
    const lowAccuracyResult = await getCurrentPositionWithOptions( lowAccuracyOptions );
    return positionToUserLocation( lowAccuracyResult );
  } catch ( e ) {
    console.warn( "All location attempts failed:", e );
  }

  return null;
};

export default fetchAccurateUserLocation;
