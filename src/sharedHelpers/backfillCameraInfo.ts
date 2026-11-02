import type Realm from "realm";
import Photo from "realmModels/Photo";
import type { RealmObservation, RealmObservationPhoto } from "realmModels/types";
import {
  libraryOriginalQuery, readLibraryCameraInfo,
} from "sharedHelpers/findLibraryOriginal";
import { log } from "sharedHelpers/logger";
import { readCameraInfo } from "sharedHelpers/photoCameraInfo";

const logger = log.extend( "backfillCameraInfo" );

// Photos already read this session, so ones without settings aren't read
// again on every change to the observations.
const attempted = new Set<string>( );

// Saves the camera settings of observation photos added before they were
// saved, read from the app's local copy, else the library original (often
// deleted after upload, and downloaded from iCloud when it isn't on the
// phone), or the library photo matched to it when the app never recorded
// which one it was or that one is gone. batchSize photos are read at a time.
const backfillCameraInfo = async (
  realm: Realm,
  observations: Iterable<RealmObservation>,
  batchSize: number,
): Promise<void> => {
  const pending: {
    obsPhoto: RealmObservationPhoto;
    local?: string;
    library: ReturnType<typeof libraryOriginalQuery>;
  }[] = [];
  Array.from( observations ).forEach( observation => {
    observation.observationPhotos?.forEach( obsPhoto => {
      if ( obsPhoto.cameraInfo || attempted.has( obsPhoto.uuid ) ) return;
      attempted.add( obsPhoto.uuid );
      pending.push( {
        obsPhoto,
        local: Photo.getLocalPhotoUri( obsPhoto.photo?.localFilePath ) ?? undefined,
        library: libraryOriginalQuery( obsPhoto, observation ),
      } );
    } );
  } );
  if ( pending.length === 0 ) return;
  let filled = 0;
  for ( let i = 0; i < pending.length; i += batchSize ) {
    const batch = pending.slice( i, i + batchSize );
    // eslint-disable-next-line no-await-in-loop
    const infos = await Promise.all( batch.map( async ( { local, library } ) => {
      const localInfo = local
        ? await readCameraInfo( local )
        : null;
      if ( localInfo?.focusDistance ) return localInfo;
      const originalInfo = await readLibraryCameraInfo( library );
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
    filled += infos.filter( Boolean ).length;
  }
  logger.info( `camera_info_backfill filled=${filled} of=${pending.length}` );
};

export default backfillCameraInfo;
