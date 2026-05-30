import { RealmContext } from "providers/contexts";
import {
  useCallback, useMemo,
} from "react";
import Observation from "realmModels/Observation";
import { confirmNoDuplicatePhotosBeforeUpload } from "sharedHelpers/duplicateUploadedDevicePhotos";
import {
  useTranslation,
} from "sharedHooks";
import useStore from "stores/useStore";

export const MS_BEFORE_TOOLBAR_RESET = 5_000;

const { useRealm } = RealmContext;

// eslint-disable-next-line no-undef
export default ( canUpload: boolean ) => {
  const realm = useRealm( );

  const setTotalToolbarIncrements = useStore( state => state.setTotalToolbarIncrements );
  const addToUploadQueue = useStore( state => state.addToUploadQueue );
  const setStartUploadObservations = useStore( state => state.setStartUploadObservations );
  const setCannotUploadObservations = useStore( state => state.setCannotUploadObservations );

  const unsyncedList = Observation.filterUnsyncedObservations( realm );
  const unsyncedUuids = useMemo( ( ) => unsyncedList.map( o => o.uuid ), [unsyncedList] );

  const { t } = useTranslation( );

  const createUploadQueueAllUnsynced = useCallback( async (
    skipSomeUuids: string[] | undefined,
  ) => {
    const uploadsUuids = unsyncedUuids
      .filter( ( uuid: string ) => !skipSomeUuids?.includes( uuid ) );
    if ( uploadsUuids.length === 0 ) {
      return;
    }
    const confirmed = await confirmNoDuplicatePhotosBeforeUpload(
      realm,
      uploadsUuids,
      t,
    );
    if ( !confirmed ) {
      return;
    }
    const uuidsQuery = uploadsUuids
      .map( ( uploadUuid: string ) => `'${uploadUuid}'` ).join( ", " );
    const uploads = realm.objects( "Observation" )
      .filtered( `uuid IN { ${uuidsQuery} }` );
    setTotalToolbarIncrements( uploads );
    addToUploadQueue( uploadsUuids );
    if ( canUpload ) {
      setStartUploadObservations( );
    } else {
      setCannotUploadObservations( );
    }
  }, [
    addToUploadQueue,
    canUpload,
    realm,
    setCannotUploadObservations,
    setStartUploadObservations,
    setTotalToolbarIncrements,
    t,
    unsyncedUuids,
  ] );

  const startUploadObservations = useCallback( async ( skipSomeUuids: string[] | undefined ) => {
    createUploadQueueAllUnsynced( skipSomeUuids );
  }, [
    createUploadQueueAllUnsynced,
  ] );

  const startUploadsFromMultiObsEdit = useCallback( async ( ) => {
    if ( canUpload ) {
      setStartUploadObservations( );
    } else {
      setCannotUploadObservations( );
    }
  }, [
    canUpload,
    setCannotUploadObservations,
    setStartUploadObservations,
  ] );

  return {
    startUploadObservations,
    startUploadsFromMultiObsEdit,
  };
};
