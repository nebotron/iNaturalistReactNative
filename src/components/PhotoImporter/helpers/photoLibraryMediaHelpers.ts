import type { Asset } from "react-native-image-picker";
import Observation from "realmModels/Observation";
import ObservationPhoto from "realmModels/ObservationPhoto";
import ObservationSound from "realmModels/ObservationSound";
import type { RealmObservationPojo } from "realmModels/types";
import type { GroupedPhotoCropMetadata } from "sharedHelpers/cropPhotoMetadata";
import type { DevicePhotoLocation } from "sharedHelpers/devicePhotoLocation";
import { firstDevicePhotoLocation } from "sharedHelpers/devicePhotoLocation";

// A photo picked from the device library, as the importer carries it: the
// picker's asset, any crop framed before import, and the location Photos holds
// for the asset (which the photo file itself may not carry).
export type ImportedAsset = Asset & GroupedPhotoCropMetadata & {
  deviceLocation?: DevicePhotoLocation;
};

export interface GroupedMediaPhotoItem {
  // Always a file the app can read: a copy of a library photo, a baked crop,
  // or a GIF extracted from a video
  image: ImportedAsset & { uri: string };
  isDuplicateUpload?: boolean;
  originalDevicePhotoUri?: string | null;
  // Set while the file is still being copied out of the device library: the
  // cell Group Photos draws for it stands in for a photo the import has not
  // written yet (see PhotoLibrary's placeholderGroup).
  pending?: boolean;
  // False for media the crop editor will never open: a video (it becomes a
  // GIF, and cropping that would write one still frame back over the
  // animation) or a GIF picked from the library. A bulk crop that counts these
  // as photos it is waiting for sits on a spinner through a transcode whose
  // output it never shows.
  croppable?: boolean;
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
): GroupedMediaItem & { soundUri: string } => ( { soundUri, timestamp } );

export const createObservationFromGroupedMedia = async (
  group: GroupedMediaItem,
): Promise<RealmObservationPojo> => {
  if ( group.photos && group.photos.length > 0 && group.soundUri ) {
    const obs = await Observation.createObservationWithPhotos( group.photos );
    const sound = await ObservationSound.new( group.soundUri );
    return Observation.appendObsSounds( [sound], obs );
  }
  if ( group.soundUri ) {
    return Observation.createObsWithSoundPath( group.soundUri );
  }
  return Observation.createObservationWithPhotos( group.photos || [] );
};

export const appendPhotosToObservation = async (
  photos: GroupedMediaPhotoItem[],
  currentObservation: RealmObservationPojo,
  photoPosition: number,
): Promise<RealmObservationPojo> => {
  if ( photos.length === 0 ) {
    return currentObservation;
  }

  // Prefer the uncropped original, which still holds the EXIF the camera wrote
  // (see Observation.createObservationFromGalleryPhotos).
  const photoUris = photos
    .map( photo => photo.image.cropOriginalUri || photo.image.uri )
    .filter( Boolean ) as string[];
  const obsPhotos = await ObservationPhoto.createObsPhotosWithPosition(
    photos,
    { position: photoPosition, local: false },
  );

  const unsynced = !currentObservation?._synced_at;
  let updatedObservation = unsynced
    ? await Observation.updateObsExifFromPhotos(
      photoUris,
      currentObservation,
      firstDevicePhotoLocation( photos ),
    )
    : currentObservation;
  updatedObservation = Observation.appendObsPhotos( obsPhotos, updatedObservation );

  return updatedObservation;
};
