import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPhoto } from "realmModels/types";
import findLibraryOriginal from "sharedHelpers/findLibraryOriginal";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const { useRealm } = RealmContext;

const BATCH_SIZE = 20;
// Photos already read this session, so ones without settings aren't read
// again on every change to the observations.
const attempted = new Set<string>( );

// Saves the camera settings of observation photos added before they were
// saved, read from the app's local copy, else the library original (often
// deleted after upload), as the media viewer does, or the library photo matched
// to it when the app never recorded which one it was.
const useBackfillCameraInfo = ( observations: Iterable<RealmObservation> ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    const pending: {
      obsPhoto: RealmObservationPhoto;
      observation: RealmObservation;
      local?: string;
      original?: string;
    }[] = [];
    Array.from( observations ).forEach( observation => {
      observation.observationPhotos?.forEach( obsPhoto => {
        const local = Photo.getLocalPhotoUri( obsPhoto.photo?.localFilePath ) ?? undefined;
        const original = obsPhoto.originalDevicePhotoUri ?? undefined;
        if ( obsPhoto.cameraInfo || attempted.has( obsPhoto.uuid ) ) {
          return;
        }
        attempted.add( obsPhoto.uuid );
        pending.push( {
          obsPhoto, observation, local, original,
        } );
      } );
    } );
    if ( pending.length === 0 ) return;
    // Not cancelled on change: each write changes the observations.
    ( async ( ) => {
      for ( let i = 0; i < pending.length; i += BATCH_SIZE ) {
        const batch = pending.slice( i, i + BATCH_SIZE );
        // eslint-disable-next-line no-await-in-loop
        const infos = await Promise.all( batch.map( async ( {
          obsPhoto, observation, local, original,
        } ) => {
          const localInfo = local
            ? await readCameraInfo( local )
            : null;
          if ( localInfo?.focusDistance ) return localInfo;
          const deviceUri = original || ( obsPhoto.isValid( )
            ? await findLibraryOriginal( obsPhoto, observation )
            : null );
          const originalInfo = deviceUri
            ? await readCameraInfo( deviceUri )
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
