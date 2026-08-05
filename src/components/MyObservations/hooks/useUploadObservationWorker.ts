import { navigationRef } from "navigation/navigationUtils";
import { RealmContext } from "providers/contexts";
import {
  useCallback, useEffect, useRef,
} from "react";
import type { AppStateStatus } from "react-native";
import { AppState, Platform } from "react-native";
import { EventRegister } from "react-native-event-listeners";
import Observation from "realmModels/Observation";
import type { RealmObservation } from "realmModels/types";
import {
  beginBackgroundUploadTask,
  endBackgroundUploadTask,
} from "sharedHelpers/backgroundExecution";
import { log } from "sharedHelpers/logger";
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

import { MS_BEFORE_TOOLBAR_RESET } from "./useUploadObservations";

const logger = log.extend( "useUploadObservationWorker" );

const MS_BEFORE_UPLOAD_TIMES_OUT = 60_000 * 5;

// UUIDs whose upload promise hasn't settled yet, and when each started.
//
// The effect below already means to skip observations that are in flight, but
// it reads activeUploads, and both resetUploadObservationsSlice and
// stopAllUploads empty that map wholesale while the promises it was tracking
// are still running. Nothing then remembers those uploads exist, so the next
// session starts them again on top of themselves: in the Aug 5 16:04–16:40 log
// four of nine observations were uploading two or three times concurrently,
// one of them for seven minutes, and the duplicate attempt on 4aeb0f76 is
// where "Media attachment failed: Accessing object which has been invalidated
// or deleted" came from — two attempts mutating one observation's photos.
//
// A module-level map survives those resets, which is the whole point. Entries
// older than the upload timeout are treated as gone rather than blocking the
// observation forever, in case a promise never settles at all.
const inFlightUploads = new Map<string, number>( );

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
  const resetSyncToolbar = useStore( state => state.resetSyncToolbar );
  const initialNumObservationsInQueue = useStore( state => state.initialNumObservationsInQueue );
  const stopAllUploads = useStore( state => state.stopAllUploads );
  const abortController = useStore( storeState => storeState.abortController );

  const { t } = useTranslation( );

  useEffect( () => {
    // eslint-disable-next-line no-undef
    let timer: number | NodeJS.Timeout;
    if ( [UPLOAD_COMPLETE, UPLOAD_CANCELLED].indexOf( uploadStatus ) >= 0 ) {
      timer = setTimeout( () => {
        resetUploadObservationsSlice( );
      }, MS_BEFORE_TOOLBAR_RESET );
    } else {
      timer = setTimeout( () => {
        resetSyncToolbar( );
      }, MS_BEFORE_TOOLBAR_RESET );
    }
    return () => {
      clearTimeout( timer );
    };
  }, [
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
    const startedAt = Date.now( );
    const previousAttemptAt = inFlightUploads.get( uuid );
    if ( previousAttemptAt !== undefined ) {
      const msSinceFirstAttempt = startedAt - previousAttemptAt;
      if ( msSinceFirstAttempt < MS_BEFORE_UPLOAD_TIMES_OUT ) {
        const state = useStore.getState( );
        logger.errorWithExtra( "upload_duplicate_attempt", {
          msSinceFirstAttempt,
          inFlight: inFlightUploads.size,
          activeUploads: Object.keys( state.activeUploads ).length,
          queueLength: state.uploadQueue.length,
          uploadStatus: state.uploadStatus,
        } );
        // The first attempt's finally still owns this UUID and will clear it
        // from activeUploads and the queue when it settles.
        return;
      }
    }
    inFlightUploads.set( uuid, startedAt );
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
      // Only if this attempt is still the one being tracked: a stale entry
      // above is overwritten rather than reused, and the abandoned attempt
      // settling later must not clear its replacement.
      if ( inFlightUploads.get( uuid ) === startedAt ) inFlightUploads.delete( uuid );
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
