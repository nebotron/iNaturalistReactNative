import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import type { UserLocation } from "sharedHelpers/accuratePositionWatcher";
import {
  getRecentAccurateFix,
  subscribeToPosition,
  TARGET_POSITIONAL_ACCURACY,
} from "sharedHelpers/accuratePositionWatcher";

export type { UserLocation };

const useWatchPosition = ( options: {
  shouldFetchLocation: boolean;
} ) => {
  const { shouldFetchLocation } = options;
  const [userLocation, setUserLocation] = useState<UserLocation | null>( null );
  const [isWatching, setIsWatching] = useState( false );

  useFocusEffect( useCallback( ( ) => {
    if ( !shouldFetchLocation ) return ( ) => {};

    let stopped = false;
    let unsubscribe: ( ( ) => void ) | null = null;

    const stop = ( ) => {
      stopped = true;
      unsubscribe?.( );
      unsubscribe = null;
      setIsWatching( false );
    };

    // A fix the app has already settled on - the camera warms location up
    // while it's open - is as good as anything a new watch would tell us, so
    // use it rather than spinning the radio back up
    const recentFix = getRecentAccurateFix( );
    if ( recentFix ) {
      setUserLocation( recentFix );
      return ( ) => setUserLocation( null );
    }

    const subscription = subscribeToPosition( {
      onLocation: location => {
        setUserLocation( location );
        if ( location.positional_accuracy <= TARGET_POSITIONAL_ACCURACY ) {
          stop( );
        }
      },
      onError: stop,
    } );
    if ( stopped ) {
      subscription( );
    } else {
      unsubscribe = subscription;
      setIsWatching( true );
    }

    return ( ) => {
      stop( );
      setUserLocation( null );
    };
  }, [shouldFetchLocation] ) );

  return { isFetchingLocation: isWatching, userLocation };
};

export default useWatchPosition;
