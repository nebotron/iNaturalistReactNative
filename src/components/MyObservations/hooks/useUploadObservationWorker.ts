import { navigationRef } from "navigation/navigationUtils";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useRef,
} from "react";
import type { AppStateStatus } from "react-native";
import { Alert, AppState, Platform } from "react-native";
import { EventRegister } from "react-native-event-listeners";
import Observation from "realmModels/Observation";
import type { RealmObservation } from "realmModels/types";
import {
  beginBackgroundUploadTask,
  endBackgroundUploadTask,
} from "sharedHelpers/backgroundExecution";
import {
  useTranslation,
} from "sharedHooks";
import {
  MAX_CONCURRENT_UPLOADS,
  UPLOAD_CANCELLED,
  UPLOAD_COMPLETE,
  UPLOAD_IN_PROGRESS,
} from "stores/createUploadObservationsSlice";
import useStore from "stores/useStore";
import { handleUploadError } from "uploaders";
import uploadObservation from "uploaders/observationUploader";
import { RECOVERY_BY } from "uploaders/utils/errorHandling";
import {
  INCREMENT_SINGLE_UPLOAD_PROGRESS,
} from "uploaders/utils/progressTracker";
import {
  formatUploadFailureAlertBody,
  getUploadFailureDetails,
} from "uploaders/utils/uploadFailureDetails";

import { MS_BEFORE_TOOLBAR_RESET } from "./useUploadObservations";

const MS_BEFORE_UPLOAD_TIMES_OUT = 60_000 * 5;

const { useRealm } = RealmContext;

const useUploadObservationWorker = ( ) => {
  const realm = useRealm( );
  const backgroundTaskActiveRef = useRef<boolean>( false );

  const addUploadError = useStore( state => state.addUploadError );
  const completeUploads = useStore( state => state.completeUploads );
  const activeUploads = useStore( state => state.activeUploads );
  const removeDeletedObsFromUploadQueue = useStore(
    state => state.removeDeletedObsFromUploadQueue,
  );
  const finishUpload = useStore( state => state.finishUpload );
  const startActiveUpload = useStore( state => state.startActiveUpload );
  const resetUploadObservationsSlice = useStore( state => state.resetUploadObservationsSlice );
  const updateTotalUploadProgress = useStore( state => state.updateTotalUploadProgress );
  const uploadQueue = useStore( state => state.uploadQueue );
  const uploadStatus = useStore( state => state.uploadStatus );
  const setNumUnuploadedObservations = useStore( state => state.setNumUnuploadedObservations );
  const resetSyncToolbar = useStore( state => state.resetSyncToolbar );
  const initialNumObservationsInQueue = useStore( state => state.initialNumObservationsInQueue );
  const stopAllUploads = useStore( state => state.stopAllUploads );
  const abortController = useStore( storeState => storeState.abortController );

  const { t } = useTranslation( );

  const resetNumUnsyncedObs = useCallback( ( ) => {
    if ( !realm || realm.isClosed ) return;
    const unsynced = Observation.filterUnsyncedObservations( realm );
    setNumUnuploadedObservations( unsynced.length );
  }, [realm, setNumUnuploadedObservations] );

  useEffect( () => {
    // eslint-disable-next-line no-undef
    let timer: number | NodeJS.Timeout;
    if ( [UPLOAD_COMPLETE, UPLOAD_CANCELLED].indexOf( uploadStatus ) >= 0 ) {
      timer = setTimeout( () => {
        resetUploadObservationsSlice( );
        resetNumUnsyncedObs( );
      }, MS_BEFORE_TOOLBAR_RESET );
    } else {
      timer = setTimeout( () => {
        resetSyncToolbar( );
        resetNumUnsyncedObs( );
      }, MS_BEFORE_TOOLBAR_RESET );
    }
    return () => {
      clearTimeout( timer );
    };
  }, [
    resetNumUnsyncedObs,
    resetSyncToolbar,
    resetUploadObservationsSlice,
    uploadStatus,
  ] );

  useEffect( ( ) => {
    const progressListener = EventRegister.addEventListener(
      INCREMENT_SINGLE_UPLOAD_PROGRESS,
      increments => {
        const uuid = increments[0];
        const increment = increments[1];
        updateTotalUploadProgress( uuid, increment );
      },
    );
    return ( ) => {
      EventRegister?.removeEventListener( progressListener as string );
    };
  }, [
    updateTotalUploadProgress,
  ] );

  const endActiveBackgroundTask = useCallback( async ( ) => {
    if ( !backgroundTaskActiveRef.current ) {
      return;
    }

    await endBackgroundUploadTask( );
    backgroundTaskActiveRef.current = false;
  }, [] );

  const startBackgroundTaskIfNeeded = useCallback( async ( ) => {
    if ( backgroundTaskActiveRef.current ) {
      return;
    }

    backgroundTaskActiveRef.current = await beginBackgroundUploadTask( );
  }, [] );

  useEffect( ( ) => {
    const ensureBackgroundTask = async ( nextAppState: AppStateStatus ) => {
      const uploadsActive = uploadStatus === UPLOAD_IN_PROGRESS;

      if ( Platform.OS === "android" ) {
        if ( uploadsActive ) {
          await startBackgroundTaskIfNeeded( );
        } else {
          await endActiveBackgroundTask( );
        }
        return;
      }

      if (
        uploadsActive
        && ( nextAppState === "background" || nextAppState === "inactive" )
      ) {
        await startBackgroundTaskIfNeeded( );
        return;
      }

      if ( !uploadsActive || nextAppState === "active" ) {
        await endActiveBackgroundTask( );
      }
    };

    if ( uploadStatus === UPLOAD_IN_PROGRESS ) {
      ensureBackgroundTask( AppState.currentState );
    } else {
      endActiveBackgroundTask( );
    }

    const subscription = AppState.addEventListener( "change", ensureBackgroundTask );

    return ( ) => {
      subscription.remove( );
      endActiveBackgroundTask( );
    };
  }, [endActiveBackgroundTask, startBackgroundTaskIfNeeded, uploadStatus] );

  const uploadObservationAndCatchError = useCallback( async ( observation: RealmObservation ) => {
    const { uuid } = observation;
    try {
      const timeoutID = setTimeout( ( ) => {
        abortController?.abort( );
      }, MS_BEFORE_UPLOAD_TIMES_OUT );
      await uploadObservation( observation, realm, { signal: abortController?.signal } );
      clearTimeout( timeoutID );
    } catch ( uploadErr ) {
      const uploadError = uploadErr as Error;
      if ( uploadError.name === "AbortError" ) {
        addUploadError( "aborted", observation.uuid );
      } else {
        let uploadFailureResult: {
          message: string;
          recoveryPossible: boolean;
          recoveryBy?: typeof RECOVERY_BY[keyof typeof RECOVERY_BY];
        };
        try {
          uploadFailureResult = handleUploadError( uploadError, t );
        } catch {
          uploadFailureResult = {
            message: uploadError.message,
            recoveryPossible: false,
          };
        }
        const { message, recoveryPossible, recoveryBy } = uploadFailureResult;

        const failureDetails = getUploadFailureDetails( uploadError );
        Alert.alert(
          t( "Upload-failed" ),
          formatUploadFailureAlertBody( failureDetails, message ),
          [{ text: t( "OK" ) }],
        );

        if ( message?.match( /That observation no longer exists./ ) ) {
          removeDeletedObsFromUploadQueue( uuid );
          await Observation.deleteLocalObservation( realm, uuid );
        } else {
          addUploadError( message, uuid );
          if ( recoveryPossible && recoveryBy === RECOVERY_BY.LOGIN_AGAIN ) {
            stopAllUploads( );
            if ( navigationRef.isReady( ) ) {
              navigationRef.navigate( "LoginStackNavigator" );
            }
          }
        }
      }
    } finally {
      finishUpload( uuid );
      // Read fresh state after finishUpload updates the store, rather
      // than the stale closure values captured when this callback was created.
      const freshState = useStore.getState( );
      if ( freshState.uploadQueue.length === 0
        && Object.keys( freshState.activeUploads ).length === 0 ) {
        completeUploads( );
      }
    }
  }, [
    abortController,
    addUploadError,
    completeUploads,
    finishUpload,
    realm,
    removeDeletedObsFromUploadQueue,
    stopAllUploads,
    t,
  ] );

  useEffect( ( ) => {
    if (
      uploadStatus !== UPLOAD_IN_PROGRESS
      || uploadQueue.length === 0
      || !abortController
      || abortController.signal.aborted
    ) {
      return;
    }

    const activeCount = Object.keys( activeUploads ).length;
    const slotsAvailable = MAX_CONCURRENT_UPLOADS - activeCount;
    if ( slotsAvailable <= 0 ) return;

    // Skip UUIDs already in-flight so we don't start the same observation twice
    const notYetActive = uploadQueue.filter( uuid => !activeUploads[uuid] );
    const uuidsToStart = notYetActive.slice( -Math.min( slotsAvailable, notYetActive.length ) );
    uuidsToStart.forEach( uuid => {
      const localObservation = realm.objectForPrimaryKey<RealmObservation>(
        "Observation",
        uuid,
      );
      if ( localObservation ) {
        startActiveUpload( uuid, localObservation );
        uploadObservationAndCatchError( localObservation );
      }
    } );
  }, [
    abortController,
    activeUploads,
    initialNumObservationsInQueue,
    realm,
    startActiveUpload,
    uploadObservationAndCatchError,
    uploadQueue,
    uploadStatus,
  ] );
};

export default useUploadObservationWorker;
