import { RealmContext } from "providers/contexts";
import {
  useCallback,
} from "react";
import Observation from "realmModels/Observation";
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

  const createUploadQueueAllUnsynced = useCallback( async (
    skipSomeUuids: string[] | undefined,
  ) => {
    const uploadsUuids = Array.from( unsyncedList )
      .filter( obs => {
        if ( skipSomeUuids?.includes( obs.uuid ) ) return false;
        // Never upload observations missing required basics (location, date,
        // evidence, or taxon), regardless of mode.
        if ( typeof obs.missingBasics === "function" && obs.missingBasics() ) return false;
        return true;
      } )
      .map( obs => obs.uuid );
    if ( uploadsUuids.length === 0 ) {
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
    unsyncedList,
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
