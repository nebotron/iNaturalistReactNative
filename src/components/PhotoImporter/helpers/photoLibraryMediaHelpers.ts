import type { Asset } from "react-native-image-picker";
import Observation from "realmModels/Observation";
import ObservationPhoto from "realmModels/ObservationPhoto";
import type { RealmObservationPojo } from "realmModels/types";

export interface GroupedMediaPhotoItem {
  image: Asset;
  isDuplicateUpload?: boolean;
  originalDevicePhotoUri?: string | null;
}

export interface GroupedMediaItem {
  photos?: GroupedMediaPhotoItem[];
  soundUri?: string;
  // Used for sorting sound items that have no photos
  timestamp?: number;
}

export const buildGroupedMediaItems = (
  photos: GroupedMediaPhotoItem[],
): GroupedMediaItem[] => photos
  .map( photo => ( { photos: [photo] } ) )
  .sort( ( a, b ) => (
    ( b.photos[0].image.timestamp as number || 0 )
    - ( a.photos[0].image.timestamp as number || 0 )
  ) );

export const buildGroupedSoundItem = (
  soundUri: string,
  timestamp?: number,
): GroupedMediaItem => ( { soundUri, timestamp } );

export const createObservationFromGroupedMedia = (
  group: GroupedMediaItem,
): Promise<RealmObservationPojo> => {
  if ( group.soundUri ) {
    return Observation.createObsWithSoundPath( group.soundUri );
  }
  return Observation.createObservationWithPhotos( group.photos || [] );
};

export const appendPhotosToObservation = async (
  photos: { image: Asset }[],
  currentObservation: RealmObservationPojo,
  photoPosition: number,
): Promise<RealmObservationPojo> => {
  if ( photos.length === 0 ) {
    return currentObservation;
  }

  const photoUris = photos.map( photo => photo.image.uri ).filter( Boolean ) as string[];
  const obsPhotos = await ObservationPhoto.createObsPhotosWithPosition(
    photos,
    { position: photoPosition, local: false },
  );

  const unsynced = !currentObservation?._synced_at;
  let updatedObservation = unsynced
    ? await Observation.updateObsExifFromPhotos( photoUris, currentObservation )
    : currentObservation;
  updatedObservation = Observation.appendObsPhotos( obsPhotos, updatedObservation );

  return updatedObservation;
};
