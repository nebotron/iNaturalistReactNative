import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import {
  requestQueuedDeletionAlbumSync,
  setQueuedDeletionAlbumSource,
} from "sharedHelpers/queuedDeletionAlbum";

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
};

export default useQueuedDeletionAlbum;
