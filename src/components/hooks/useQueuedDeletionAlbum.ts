import { getJWT } from "components/LoginSignUp/AuthenticationService";
import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import { log } from "sharedHelpers/logger";
import {
  requestQueuedDeletionAlbumSync,
  setQueuedDeletionAlbumSource,
} from "sharedHelpers/queuedDeletionAlbum";
import { syncUserObservations } from "sharedHelpers/userObservationsCache";

const logger = log.extend( "useQueuedDeletionAlbum" );

const { useRealm } = RealmContext;

// Re-files the deletion album whenever an observation is created, edited,
// faved or deleted. Realm calls the listener once on registration too, which
// brings the album up to date at launch.
const useQueuedDeletionAlbum = ( userId?: number ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    setQueuedDeletionAlbumSource( realm, userId );
    const observations = realm.objects( "Observation" );
    observations.addListener( requestQueuedDeletionAlbumSync );
    return ( ) => {
      observations.removeListener( requestQueuedDeletionAlbumSync );
      setQueuedDeletionAlbumSource( null );
    };
  }, [realm, userId] );

  // Faves made on another device or the website reach the album only through
  // the shared observation cache, so bring it up to date at launch.
  useEffect( ( ) => {
    if ( !userId ) return;
    getJWT( )
      .then( apiToken => syncUserObservations( userId, { api_token: apiToken } ) )
      .then( requestQueuedDeletionAlbumSync )
      .catch( error => logger.warn( "Could not sync observations", error ) );
  }, [userId] );
};

export default useQueuedDeletionAlbum;
