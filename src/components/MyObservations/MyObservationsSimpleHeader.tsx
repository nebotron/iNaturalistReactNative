import { useNavigation } from "@react-navigation/native";
import {
  HeaderUser,
  Heading3,
  INatIconButton,
  RotatingINatIconButton,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React from "react";
import { Alert } from "react-native";
import Observation from "realmModels/Observation";
import type {
  RealmUser,
} from "realmModels/types";
import { useTranslation } from "sharedHooks";
import {
  MANUAL_SYNC_IN_PROGRESS,
} from "stores/createSyncObservationsSlice";
import {
  UPLOAD_COMPLETE,
  UPLOAD_IN_PROGRESS,
  UPLOAD_PENDING,
} from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";
import colors from "styles/tailwindColors";

import SimpleUploadBannerContainer from "./SimpleUploadBannerContainer";

const { useRealm } = RealmContext;

interface Props {
  currentUser?: RealmUser;
  numUploadableObservations: number;
  handleSyncButtonPress: ( ) => void;
  isConnected: boolean;
}

const MyObservationsSimpleHeader = ( {
  currentUser,
  handleSyncButtonPress,
  isConnected,
  numUploadableObservations,
}: Props ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const realm = useRealm( );
  const setObservations = useStore( state => state.setObservations );
  const resetObservationFlowSlice = useStore( state => state.resetObservationFlowSlice );
  const setBulkUploadMode = useStore( state => state.setBulkUploadMode );

  const handleBulkIDPress = ( ) => {
    const unsyncedObs = Observation.filterUnsyncedObservations( realm );
    const unknownUnsyncedObs = unsyncedObs.filtered( "taxon == nil" );
    if ( unknownUnsyncedObs.length === 0 ) {
      Alert.alert( "No Unuploaded Observations", "All your observations have been uploaded." );
      return;
    }
    resetObservationFlowSlice( );
    setObservations( Array.from( unknownUnsyncedObs ) );
    setBulkUploadMode( true );
    navigation.navigate( "Suggestions", {
      entryScreen: "ObsEdit",
      lastScreen: "ObsEdit",
    } );
  };

  // TODO: all the code related to showing the sync button is pretty convoluted and'
  // should be cleaned up at some point, but right now it's ported from our ToolbarContainer/Toolbar
  // code from the Soft Launch version of the app 20250218
  const currentDeleteCount = useStore( state => state.currentDeleteCount );
  const uploadErrorsByUuid = useStore( state => state.errorsByUuid );
  const initialNumObservationsInQueue = useStore( state => state.initialNumObservationsInQueue );
  const uploadStatus = useStore( state => state.uploadStatus );
  const syncingStatus = useStore( state => state.syncingStatus );
  const initialNumDeletionsInQueue = useStore( state => state.initialNumDeletionsInQueue );
  const numUploadsAttempted = useStore( state => state.numUploadsAttempted );

  const deletionsComplete = initialNumDeletionsInQueue === currentDeleteCount;
  const deletionsInProgress = initialNumDeletionsInQueue > 0 && !deletionsComplete;

  const manualSyncInProgress = syncingStatus === MANUAL_SYNC_IN_PROGRESS;
  const pendingUpload = uploadStatus === UPLOAD_PENDING && numUploadableObservations > 0;
  const uploadInProgress = uploadStatus === UPLOAD_IN_PROGRESS && numUploadsAttempted > 0;
  const uploadsComplete = uploadStatus === UPLOAD_COMPLETE && initialNumObservationsInQueue > 0;
  const totalUploadErrors = Object.keys( uploadErrorsByUuid ).length;

  const showFinalUploadError = ( totalUploadErrors > 0 && uploadsComplete )
  || ( totalUploadErrors > 0 && ( numUploadsAttempted === initialNumObservationsInQueue ) );

  const rotating = manualSyncInProgress || uploadInProgress || deletionsInProgress;

  let showsExclamation = pendingUpload || showFinalUploadError;

  // The exclamation mark should *never* appear while rotating, no matter what
  // the props say
  if ( rotating ) showsExclamation = false;

  return (
    <>
      <SimpleUploadBannerContainer
        handleSyncButtonPress={handleSyncButtonPress}
        numUploadableObservations={numUploadableObservations}
        currentUser={currentUser}
      />
      <View className="flex-row justify-between items-center px-5 py-1">
        {currentUser
          ? <HeaderUser user={currentUser} isConnected={isConnected} />
          : <Heading3>{ t( "My-Observations" ) }</Heading3>}
        {currentUser && (
          <View className="flex-row items-center">
            {numUploadableObservations > 0 && (
              <INatIconButton
                icon="sparkly-label"
                // eslint-disable-next-line i18next/no-literal-string
                accessibilityLabel="Add IDs to unuploaded observations"
                onPress={handleBulkIDPress}
                color={String( colors?.inatGreen )}
                size={26}
                testID="BulkIDButton"
              />
            )}
            <RotatingINatIconButton
              icon={
                showsExclamation
                  ? "sync-unsynced"
                  : "sync"
              }
              onPress={handleSyncButtonPress}
              color={String(
                numUploadableObservations > 0
                  ? colors?.inatGreen
                  : colors?.darkGray,
              )}
              rotating={rotating}
              disabled={rotating}
              accessibilityLabel={t( "Sync-observations" )}
              size={26}
              testID="SyncButton"
            />
          </View>
        )}
      </View>
    </>
  );
};

export default MyObservationsSimpleHeader;
