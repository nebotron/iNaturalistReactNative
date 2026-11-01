import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPhoto } from "realmModels/types";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const { useRealm } = RealmContext;

const BATCH_SIZE = 20;
// Photos already read this session, so ones without settings aren't read
// again on every change to the observations.
const attempted = new Set<string>( );

// Saves the camera settings of observation photos added before they were
// saved, read from the app's local copy, else the library original (often
// deleted after upload), as the media viewer does.
const useBackfillCameraInfo = ( observations: Iterable<RealmObservation> ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    const pending: { obsPhoto: RealmObservationPhoto; local?: string; original?: string }[] = [];
    Array.from( observations ).forEach( observation => {
      observation.observationPhotos?.forEach( obsPhoto => {
        const local = Photo.getLocalPhotoUri( obsPhoto.photo?.localFilePath ) ?? undefined;
        const original = obsPhoto.originalDevicePhotoUri ?? undefined;
        if ( obsPhoto.cameraInfo || ( !local && !original ) || attempted.has( obsPhoto.uuid ) ) {
          return;
        }
        attempted.add( obsPhoto.uuid );
        pending.push( { obsPhoto, local, original } );
      } );
    } );
    if ( pending.length === 0 ) return;
    // Not cancelled on change: each write changes the observations.
    ( async ( ) => {
      for ( let i = 0; i < pending.length; i += BATCH_SIZE ) {
        const batch = pending.slice( i, i + BATCH_SIZE );
        // eslint-disable-next-line no-await-in-loop
        const infos = await Promise.all( batch.map( async ( { local, original } ) => {
          const localInfo = local
            ? await readCameraInfo( local )
            : null;
          const originalInfo = original && !localInfo?.focusDistance
            ? await readCameraInfo( original )
            : null;
          return localInfo || originalInfo
            ? {
              ...originalInfo,
              ...Object.fromEntries( Object.entries( localInfo ?? {} ).filter( ( [, v] ) => v ) ),
            }
            : null;
        } ) );
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
