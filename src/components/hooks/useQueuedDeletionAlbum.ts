import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import type { CollectionChangeSet, Results } from "realm";
import { log } from "sharedHelpers/logger";
import {
  requestAlbumRefile,
  requestUsbStagingExpiry,
  setQueuedDeletionAlbumSource,
} from "sharedHelpers/queuedDeletionAlbum";
import { syncUserObservations } from "sharedHelpers/userObservationsCache";

const logger = log.extend( "useQueuedDeletionAlbum" );

const { useRealm } = RealmContext;

// What deciding an observation's photos' place in the album reads. Without key
// paths the listener fired on every write to any observation: each upload's
// progress, every synced identification and comment. Creating and deleting
// observations always notifies.
const ALBUM_KEY_PATHS = [
  "votes",
  "votes.vote_scope",
  "observationPhotos",
  "observationPhotos._synced_at",
  "observationPhotos.originalDevicePhotoUri",
  "observationPhotos.photo.cropX",
  "observationPhotos.photo.cropY",
  "observationPhotos.photo.cropW",
  "observationPhotos.photo.cropH",
];

// Refiles the photos of each observation as it is created, edited or faved,
// and only those: the change set names them. Realm's first call, on
// registration, names none. A deleted observation leaves its photos where they
// are.
const refileChanged = (
  observations: Results<{ uuid: string }>,
  changes: CollectionChangeSet,
) => {
  requestAlbumRefile( [...changes.insertions, ...changes.newModifications]
    .map( index => observations[index]?.uuid ) );
};
const useQueuedDeletionAlbum = ( userId?: number ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    setQueuedDeletionAlbumSource( realm, userId );
    const observations = realm.objects( "Observation" );
    observations.addListener( refileChanged, ALBUM_KEY_PATHS );
    return ( ) => {
      observations.removeListener( refileChanged );
      setQueuedDeletionAlbumSource( null );
    };
  }, [realm, userId] );

  // Faves made on another device or the website reach the album only through
  // the shared observation cache, which tells the album the observations whose
  // fave changed, so bring it up to date at launch. Expiring staged USB photos
  // waits for it, since it keeps the faved ones.
  useEffect( ( ) => {
    if ( !userId ) {
      requestUsbStagingExpiry( );
      return;
    }
    getJWT( )
      .then( apiToken => syncUserObservations( userId, { api_token: apiToken } ) )
      .catch( error => logger.warn( "Could not sync observations", error ) )
      .finally( requestUsbStagingExpiry );
  }, [userId] );
};

export default useQueuedDeletionAlbum;
