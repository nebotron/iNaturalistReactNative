import { navigationRef } from "navigation/navigationUtils";
import { useEffect, useRef } from "react";
import { useOnboardingShown } from "sharedHelpers/installData";
import useStore from "stores/useStore";

// On a cold start, if the user has in-progress Group Photos work saved in the
// persisted store, take them straight back to the Group Photos screen so they
// pick up exactly where they left off, rather than landing on the default tab.
const useResumeGroupPhotos = ( ) => {
  const [onboardingShown] = useOnboardingShown( );
  const resumedRef = useRef( false );

  useEffect( ( ) => {
    // Don't jump into a deep screen before the user has finished onboarding.
    if ( !onboardingShown ) { return ( ) => undefined; }

    const resume = ( ) => {
      if ( resumedRef.current ) { return; }
      // Guard against firing before the navigator has mounted, e.g. right
      // as the app cold-starts on the Login/Onboarding screen.
      if ( !navigationRef.isReady( ) ) { return; }
      const { groupedPhotos } = useStore.getState( );
      if ( groupedPhotos && groupedPhotos.length > 0 ) {
        resumedRef.current = true;
        // Resume inside the My Observations tab so the import keeps the bottom
        // tab bar and the user can step away from it and come back
        navigationRef.navigate( "TabNavigator", {
          screen: "ObservationsTab",
          params: { screen: "GroupPhotos" },
        } );
      }
    };

    // The persisted store rehydrates asynchronously; wait for it so we don't
    // read an empty default before the saved progress is loaded.
    let unsubscribe = ( ) => undefined;
    if ( useStore.persist.hasHydrated( ) ) {
      resume( );
    } else {
      unsubscribe = useStore.persist.onFinishHydration( resume );
    }
    return ( ) => unsubscribe( );
  }, [onboardingShown] );
};

export default useResumeGroupPhotos;
