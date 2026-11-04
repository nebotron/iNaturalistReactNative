import type { UserLocation } from "./accuratePositionWatcher";
import { waitForAccuratePosition } from "./accuratePositionWatcher";
// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import {
  checkLocationPermissions,
  getCurrentPositionWithOptions,
  lowAccuracyOptions,
} from "./geolocationWrapper";

const fetchAccurateUserLocation = async (): Promise<UserLocation | null> => {
  const permissionResult = await checkLocationPermissions( );
  if ( permissionResult === null ) {
    return null;
  }

  try {
    // Watches until the fix is accurate enough rather than taking the first
    // one the OS produces, which is usually a coarse network or cached fix
    const accurateResult = await waitForAccuratePosition( );
    if ( accurateResult ) {
      return accurateResult;
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
