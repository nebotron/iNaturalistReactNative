import { RealmContext } from "providers/contexts";
import { useEffect } from "react";
import type { FavoritableObservation } from "sharedHelpers/queuedDeletionAlbum";
import {
  onObservationsChanged,
  setQueuedDeletionAlbumSource,
} from "sharedHelpers/queuedDeletionAlbum";

const { useRealm } = RealmContext;

// What the deletion album reacts to. Without key paths the listener fired on
// every write to any observation -- each upload's progress, every synced
// identification and comment. Creating and deleting observations always
// notifies.
const ALBUM_KEY_PATHS = [
  "votes",
  "votes.vote_scope",
  "observationPhotos",
  "observationPhotos._synced_at",
  "observationPhotos.originalDevicePhotoUri",
];

// Keeps the deletion album in step as observations are created, edited, faved
// and unfaved, one changed observation at a time.
const useQueuedDeletionAlbum = ( ) => {
  const realm = useRealm( );

  useEffect( ( ) => {
    setQueuedDeletionAlbumSource( realm );
    const observations = realm.objects<FavoritableObservation>( "Observation" );
    observations.addListener( onObservationsChanged, ALBUM_KEY_PATHS );
    return ( ) => {
      observations.removeListener( onObservationsChanged );
      setQueuedDeletionAlbumSource( null );
    };
  }, [realm] );
};

export default useQueuedDeletionAlbum;
