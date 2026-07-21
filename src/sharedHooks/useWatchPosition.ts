import type {
  GeolocationError,
  GeolocationResponse,
} from "@react-native-community/geolocation";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";

// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import { clearWatch, watchPosition } from "../sharedHelpers/geolocationWrapper";

export const TARGET_POSITIONAL_ACCURACY = 10;
const MAX_POSITION_AGE_MS = 60_000;

export interface UserLocation {
  latitude: number;
  longitude: number;
  positional_accuracy: number;
  altitude: number | null;
  altitudinal_accuracy: number | null;
}

const geolocationOptions = {
  distanceFilter: 0,
  enableHighAccuracy: true,
  maximumAge: 0,
};

const useWatchPosition = ( options: {
  shouldFetchLocation: boolean;
} ) => {
  const { shouldFetchLocation } = options;
  const [userLocation, setUserLocation] = useState<UserLocation | null>( null );
  const [isWatching, setIsWatching] = useState( false );

  useFocusEffect( useCallback( ( ) => {
    if ( !shouldFetchLocation ) return ( ) => {};

    let id: number | null = null;

    const stop = ( ) => {
      if ( id !== null ) {
        clearWatch( id );
        id = null;
      }
      setIsWatching( false );
    };

    const success = ( position: GeolocationResponse ) => {
      const age = Date.now() - position.timestamp;
      // 20260710 - FLGMwt: I don't know if this is necessary since
      // we're passing maxAge: 0, but left it during a refactor for safety
      // I didn't notice an impact testing on Android nor iOS with & w/o it.
      if ( age > MAX_POSITION_AGE_MS ) {
        return;
      }
      // Ignore fixes without a usable accuracy value. A fix with no (or a
      // non-positive) reported accuracy can't be compared against others and
      // shouldn't be allowed to overwrite a good fix we already have.
      const accuracy = position?.coords?.accuracy;
      if ( typeof accuracy !== "number" || accuracy <= 0 ) return;
      const newLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        positional_accuracy: accuracy,
        altitude: position.coords.altitude,
        altitudinal_accuracy: position.coords.altitudeAccuracy,
      };
      // GPS accuracy fluctuates between fixes, so keep the most accurate fix
      // we've seen this session rather than blindly overwriting with the latest
      // one. This prevents a good fix from being replaced by a subsequent worse
      // reading (especially when the target accuracy is never reached).
      setUserLocation( previousLocation => {
        if ( !previousLocation ) return newLocation;
        const previousAccuracy = previousLocation.positional_accuracy;
        if ( typeof previousAccuracy !== "number" ) return newLocation;
        return accuracy < previousAccuracy
          ? newLocation
          : previousLocation;
      } );
      if ( accuracy < TARGET_POSITIONAL_ACCURACY ) {
        stop( );
      }
    };

    const failure = ( error: GeolocationError ) => {
      console.warn( "useWatchPosition error:", error );
      stop( );
    };

    id = watchPosition( success, failure, geolocationOptions );
    setIsWatching( true );

    return ( ) => {
      stop( );
      setUserLocation( null );
    };
  }, [shouldFetchLocation] ) );

  return { isFetchingLocation: isWatching, userLocation };
};

export default useWatchPosition;
