import type { UserLocation } from "./accuratePositionWatcher";
import {
  getBestRecentFix,
  waitForAccuratePosition,
  watchHasFix,
} from "./accuratePositionWatcher";
// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import {
  checkLocationPermissions,
  getCurrentPositionWithOptions,
  lowAccuracyOptions,
} from "./geolocationWrapper";

const fetchAccurateUserLocation = async (): Promise<UserLocation | null> => {
  // A fix from the running watch (the camera keeps one open) already shows
  // location is allowed. The permission check and the one-shot request below
  // both ask locationd synchronously on the main thread on iOS, and when that
  // stalled the app froze on the camera's checkmark until iOS killed it, so
  // neither runs while the watch can answer instead.
  const watching = watchHasFix( );
  if ( !watching ) {
    const permissionResult = await checkLocationPermissions( );
    if ( permissionResult === null ) {
      return null;
    }
  }

  try {
    // Watches until the fix is accurate enough rather than taking the first
    // one the OS produces, which is usually a coarse network or cached fix
    const accurateResult = await waitForAccuratePosition( );
    if ( accurateResult ) {
      return accurateResult;
    }

    if ( watching ) {
      return getBestRecentFix( );
    }

    const lowAccuracyResult = await getCurrentPositionWithOptions( lowAccuracyOptions );

    return {
      latitude: lowAccuracyResult.coords.latitude,
      longitude: lowAccuracyResult.coords.longitude,
      positional_accuracy: lowAccuracyResult.coords.accuracy,
      altitude: lowAccuracyResult.coords.altitude,
      altitudinal_accuracy: lowAccuracyResult.coords.altitudeAccuracy,
    };
  } catch ( e ) {
    console.warn( "All location attempts failed:", e );
  }

  return null;
};

export default fetchAccurateUserLocation;
