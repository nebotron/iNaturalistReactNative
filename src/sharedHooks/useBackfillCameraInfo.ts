import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import type { RealmObservation, RealmObservationPhoto } from "realmModels/types";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const { useRealm } = RealmContext;

const BATCH_SIZE = 20;
// Library originals already read this session, so photos without settings
// aren't read again on every change to the observations.
const attempted = new Set<string>( );

// Saves the camera settings of observation photos added before they were
// saved, read from their originals in the photo library.
const useBackfillCameraInfo = ( observations: Iterable<RealmObservation> ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    const pending: { obsPhoto: RealmObservationPhoto; uri: string }[] = [];
    Array.from( observations ).forEach( observation => {
      observation.observationPhotos?.forEach( obsPhoto => {
        const uri = obsPhoto.originalDevicePhotoUri;
        if ( obsPhoto.cameraInfo || !uri || attempted.has( uri ) ) return;
        attempted.add( uri );
        pending.push( { obsPhoto, uri } );
      } );
    } );
    if ( pending.length === 0 ) return;
    // Not cancelled on change: each write changes the observations.
    ( async ( ) => {
      for ( let i = 0; i < pending.length; i += BATCH_SIZE ) {
        const batch = pending.slice( i, i + BATCH_SIZE );
        // eslint-disable-next-line no-await-in-loop
        const infos = await Promise.all( batch.map( ( { uri } ) => readCameraInfo( uri ) ) );
        if ( realm.isClosed ) break;
        realm.write( ( ) => {
          batch.forEach( ( { obsPhoto }, index ) => {
            if ( infos[index] && obsPhoto.isValid( ) && !obsPhoto.cameraInfo ) {
              obsPhoto.cameraInfo = JSON.stringify( infos[index] );
            }
          } );
        } );
      }
    } )( );
  }, [observations, realm] );
};

export default useBackfillCameraInfo;
