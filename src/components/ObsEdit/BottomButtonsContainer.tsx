import {
  useNetInfo,
} from "@react-native-community/netinfo";
import { REQUIRED_LOCATION_ACCURACY } from "components/LocationPicker/CrosshairCircle";
import React, { useCallback, useState } from "react";
import type { RealmObservation } from "realmModels/types";
import {
  useCurrentUser,
} from "sharedHooks";
import useStore from "stores/useStore";

import type { ButtonType, ButtonTypeNonNull } from "./BottomButtons";
import BottomButtons, { UPLOAD } from "./BottomButtons";
import ImpreciseLocationSheet from "./Sheets/ImpreciseLocationSheet";
import MissingEvidenceSheet from "./Sheets/MissingEvidenceSheet";

interface Props {
  passesEvidenceTest: boolean;
  currentObservation: RealmObservation;
  loading: boolean;
  saveAndAdvance: ( type: typeof UPLOAD | "save" ) => Promise<boolean>;
}

const BottomButtonsContainer = ( {
  passesEvidenceTest,
  currentObservation,
  loading,
  saveAndAdvance,
}: Props ) => {
  const { isConnected } = useNetInfo( );
  const currentUser = useCurrentUser( );
  const cameraRollUris = useStore( state => state.cameraRollUris );
  const unsavedChanges = useStore( state => state.unsavedChanges );
  const isNewObs = !currentObservation._created_at;
  const hasPhotos = currentObservation.observationPhotos?.length > 0;
  const hasImportedPhotos = hasPhotos && cameraRollUris.length === 0;

  const [showMissingEvidenceSheet, setShowMissingEvidenceSheet] = useState( false );
  const [showImpreciseLocationSheet, setShowImpreciseLocationSheet] = useState( false );
  const [allowUserToUpload, setAllowUserToUpload] = useState( false );
  const [buttonPressed, setButtonPressed] = useState<ButtonType>( null );
  const [manualLoading, setManualLoading] = useState( false );

  const hasIdentification = currentObservation.taxon
    && currentObservation.taxon.rank_level !== 100;

  const passesTests = passesEvidenceTest && hasIdentification;

  const setNextScreen = useCallback( async ( type: ButtonTypeNonNull ) => {
    const succeeded = await saveAndAdvance( type === UPLOAD
      ? UPLOAD
      : "save" );
    setManualLoading( false );
    setButtonPressed( null );
    if ( !succeeded ) {
      return;
    }
  }, [saveAndAdvance] );

  const showMissingEvidence = useCallback( ( ) => {
    if ( allowUserToUpload ) { return false; }
    // missing evidence sheet takes precedence over the location imprecise sheet

    if (
      currentObservation?.positional_accuracy
      && currentObservation?.positional_accuracy > REQUIRED_LOCATION_ACCURACY
      // Don't check for valid positional accuracy in case of a new observation with imported photos
      && ( !isNewObs || !hasImportedPhotos )
    ) {
      setShowImpreciseLocationSheet( true );
      return true;
    }
    if ( !passesEvidenceTest ) {
      setShowMissingEvidenceSheet( true );
      setAllowUserToUpload( true );
      return true;
    }

    return false;
  }, [
    allowUserToUpload,
    currentObservation,
    hasImportedPhotos,
    isNewObs,
    passesEvidenceTest,
  ] );

  const handlePress = useCallback( ( type: ButtonTypeNonNull ) => {
    if ( showMissingEvidence( ) ) { return; }
    setManualLoading( true );
    setButtonPressed( type );
    setNextScreen( type );
  }, [setNextScreen, showMissingEvidence] );

  return (
    <>
      {showMissingEvidenceSheet && (
        <MissingEvidenceSheet
          setShowMissingEvidenceSheet={setShowMissingEvidenceSheet}
        />
      )}
      {showImpreciseLocationSheet && (
        <ImpreciseLocationSheet
          setShowImpreciseLocationSheet={setShowImpreciseLocationSheet}
        />
      )}
      <BottomButtons
        buttonPressed={buttonPressed}
        canSaveOnly={!currentUser || !isConnected}
        handlePress={handlePress}
        loading={manualLoading || loading}
        showFocusedChangesButton={unsavedChanges}
        showFocusedUploadButton={!!passesTests}
        showHalfOpacity={!passesEvidenceTest}
        wasSynced={!!( currentObservation?._synced_at )}
      />
    </>
  );
};

export default BottomButtonsContainer;
