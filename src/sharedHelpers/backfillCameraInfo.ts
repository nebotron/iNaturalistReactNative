import { MMKV } from "react-native-mmkv";
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

// Photos no read found settings for (originals deleted, or no library photo
// matches), by when that was, so every launch doesn't read thousands of them
// again. Retried after a while: a matching photo may be added to the library.
const RETRY_UNFILLABLE_MS = 7 * 24 * 60 * 60 * 1000;
// Versioned: a change to how photos are matched retries every one it missed.
// v2: same-shot duplicates and obscured observations match.
const UNFILLABLE_KEY = "unfillableAt-v2";
const store = new MMKV( { id: "camera-info-backfill" } );
store.delete( "unfillableAt" );
let unfillable: Record<string, number> | null = null;

const getUnfillable = ( ): Record<string, number> => {
  if ( !unfillable ) {
    const saved: Record<string, number> = JSON.parse( store.getString( UNFILLABLE_KEY ) ?? "{}" );
    const now = Date.now( );
    unfillable = Object.fromEntries( Object.entries( saved )
      .filter( ( [, at] ) => now - at < RETRY_UNFILLABLE_MS ) );
  }
  return unfillable;
};

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
  const skip = getUnfillable( );
  Array.from( observations ).forEach( observation => {
    observation.observationPhotos?.forEach( obsPhoto => {
      if ( obsPhoto.cameraInfo || attempted.has( obsPhoto.uuid ) || skip[obsPhoto.uuid] ) return;
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
  // Saved every so often, not per batch: the list runs to thousands.
  let unsaved = 0;
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
    const misses = batch.filter( ( { obsPhoto }, index ) => !infos[index] && obsPhoto.isValid( ) );
    misses.forEach( ( { obsPhoto } ) => { skip[obsPhoto.uuid] = Date.now( ); } );
    unsaved += misses.length;
    if ( unsaved >= 100 ) {
      store.set( UNFILLABLE_KEY, JSON.stringify( skip ) );
      unsaved = 0;
    }
    filled += infos.filter( Boolean ).length;
  }
  if ( unsaved > 0 ) store.set( UNFILLABLE_KEY, JSON.stringify( skip ) );
  logger.info( `camera_info_backfill filled=${filled} of=${pending.length} `
    + `unfillable=${Object.keys( skip ).length}` );
};

export default backfillCameraInfo;
