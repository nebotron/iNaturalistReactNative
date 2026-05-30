import { useNetInfo } from "@react-native-community/netinfo";
import useUploadObservations from "components/MyObservations/hooks/useUploadObservations";
import { RealmContext } from "providers/contexts";
import { useCallback, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import { confirmNoDuplicatePhotosBeforeUpload } from "sharedHelpers/duplicateUploadedDevicePhotos";
import saveObservation from "sharedHelpers/saveObservation";
import shouldPromptDeleteOriginalPhotos from "sharedHelpers/shouldPromptDeleteOriginalPhotos";
import {
  useCurrentUser,
  useExitObservationFlow,
  useTranslation,
} from "sharedHooks";
import useStore from "stores/useStore";

import { UPLOAD } from "../BottomButtons";

const { useRealm } = RealmContext;

interface Options {
  currentObservation: RealmObservation | null;
  currentObservationIndex: number;
  observations: object[];
  transitionAnimation: ( ) => void;
}

const useMultiObsSaveAndAdvance = ( {
  currentObservation,
  currentObservationIndex,
  observations,
  transitionAnimation,
}: Options ) => {
  const { isConnected } = useNetInfo( );
  const { t } = useTranslation( );
  const currentUser = useCurrentUser( );
  const cameraRollUris = useStore( state => state.cameraRollUris );
  const addToUploadQueue = useStore( state => state.addToUploadQueue );
  const addTotalToolbarIncrements = useStore( state => state.addTotalToolbarIncrements );
  const resetMyObsOffsetToRestore = useStore( state => state.resetMyObsOffsetToRestore );
  const setMyObsOffset = useStore( state => state.setMyObsOffset );
  const setSavedOrUploadedMultiObsFlow = useStore( state => state.setSavedOrUploadedMultiObsFlow );
  const incrementTotalSavedObservations = useStore(
    state => state.incrementTotalSavedObservations,
  );
  const removeObservationFromMultiObsFlowAtIndex = useStore(
    state => state.removeObservationFromMultiObsFlowAtIndex,
  );
  const getCurrentObservation = useStore( state => state.getCurrentObservation );
  const realm = useRealm( );
  const exitObservationFlow = useExitObservationFlow( );
  const [loading, setLoading] = useState( false );

  const canUpload = !!( currentUser && isConnected );
  const { startUploadsFromMultiObsEdit } = useUploadObservations( canUpload );

  const saveAndAdvance = useCallback( async (
    type: typeof UPLOAD | "save",
  ): Promise<boolean> => {
    const observation = getCurrentObservation( );
    if ( !observation ) {
      return false;
    }
    const savedObservationIndex = useStore.getState( ).currentObservationIndex;
    const numObservations = useStore.getState( ).observations.length;
    const savedObservation = await saveObservation( observation, cameraRollUris, realm );
    if ( !savedObservation ) {
      return false;
    }

    const observationIsNew = !observation._created_at;
    if ( numObservations > 1 ) {
      transitionAnimation( );
      setSavedOrUploadedMultiObsFlow( );
    }
    if ( observationIsNew ) {
      resetMyObsOffsetToRestore( );
      setMyObsOffset( 0 );
    }
    if ( type === UPLOAD ) {
      const { uuid } = savedObservation;
      const confirmed = await confirmNoDuplicatePhotosBeforeUpload(
        realm,
        [uuid],
        t,
      );
      if ( !confirmed ) {
        return false;
      }
      addTotalToolbarIncrements( savedObservation );
      addToUploadQueue( uuid );
      startUploadsFromMultiObsEdit( );
    } else {
      incrementTotalSavedObservations( );
    }

    if ( numObservations === 1 ) {
      exitObservationFlow( {
        promptDeleteOriginalPhotos: shouldPromptDeleteOriginalPhotos( ),
      } );
    } else {
      removeObservationFromMultiObsFlowAtIndex( savedObservationIndex );
    }
    return true;
  }, [
    addToUploadQueue,
    addTotalToolbarIncrements,
    cameraRollUris,
    exitObservationFlow,
    getCurrentObservation,
    incrementTotalSavedObservations,
    realm,
    removeObservationFromMultiObsFlowAtIndex,
    resetMyObsOffsetToRestore,
    setMyObsOffset,
    setSavedOrUploadedMultiObsFlow,
    startUploadsFromMultiObsEdit,
    t,
    transitionAnimation,
  ] );

  return {
    loading,
    saveAndAdvance,
  };
};

export default useMultiObsSaveAndAdvance;
