import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import type { RealmObservation } from "realmModels/types";
import backfillCameraInfo from "sharedHelpers/backfillCameraInfo";

const { useRealm } = RealmContext;

// Backfills the camera settings of the observations on screen (see
// backfillCameraInfo); useDeferredStartup does the rest in the background.
const useBackfillCameraInfo = ( observations: Iterable<RealmObservation> ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    // Not cancelled on change: each write changes the observations.
    backfillCameraInfo( realm, observations, 20 );
  }, [observations, realm] );
};

export default useBackfillCameraInfo;
