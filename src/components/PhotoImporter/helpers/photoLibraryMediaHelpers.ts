import type { Asset } from "react-native-image-picker";
import Observation from "realmModels/Observation";
import ObservationPhoto from "realmModels/ObservationPhoto";
import ObservationSound from "realmModels/ObservationSound";
import type { RealmObservationPojo } from "realmModels/types";
import extractAudioFromVideo from "sharedHelpers/extractAudioFromVideo";
import readExifFromMultiplePhotos from "sharedHelpers/parseExif";
import type { VideoMediaMetadata } from "sharedHelpers/readVideoMetadata";
import { readMetadataFromMultipleVideos } from "sharedHelpers/readVideoMetadata";

export type MediaMetadata = VideoMediaMetadata;

export interface MovedVideoAsset {
  uri: string;
  asset: Asset;
}

export interface GroupedMediaPhotoItem {
  image: Asset;
  isDuplicateUpload?: boolean;
  originalDevicePhotoUri?: string | null;
}

export interface GroupedMediaItem {
  photos?: GroupedMediaPhotoItem[];
  videos?: MovedVideoAsset[];
}

export const isVideoGroup = ( group: GroupedMediaItem ) => (
  ( group.videos?.length || 0 ) > 0
);

export const isPhotoGroup = ( group: GroupedMediaItem ) => (
  ( group.photos?.length || 0 ) > 0
);

export const getGroupMediaUri = ( group: GroupedMediaItem ) => (
  group.photos?.[0]?.image?.uri || group.videos?.[0]?.uri
);

export const countGroupedMedia = ( groups: GroupedMediaItem[] ) => (
  groups.reduce(
    ( count, group ) => count + ( group.photos?.length || group.videos?.length || 0 ),
    0,
  )
);

export const buildGroupedMediaItems = (
  photos: GroupedMediaPhotoItem[],
  movedVideos: MovedVideoAsset[],
): GroupedMediaItem[] => [
  ...photos.map( photo => ( { photos: [photo] } ) ),
  ...movedVideos.map( video => ( { videos: [video] } ) ),
];

export const isVideoAsset = ( asset: Asset ) => (
  asset.type?.startsWith( "video/" ) === true
);

export const partitionAssetsByMediaType = ( assets: Asset[] ) => {
  const photoAssets: Asset[] = [];
  const videoAssets: Asset[] = [];

  assets.forEach( asset => {
    if ( isVideoAsset( asset ) ) {
      videoAssets.push( asset );
    } else {
      photoAssets.push( asset );
    }
  } );

  return { photoAssets, videoAssets };
};

export const mergeMediaMetadata = (
  ...metadataList: MediaMetadata[]
): MediaMetadata => {
  const unifiedMetadata: MediaMetadata = {};

  metadataList.forEach( metadata => {
    if ( !unifiedMetadata.latitude && metadata.latitude ) {
      unifiedMetadata.latitude = metadata.latitude;
    }
    if ( !unifiedMetadata.longitude && metadata.longitude ) {
      unifiedMetadata.longitude = metadata.longitude;
    }
    if ( !unifiedMetadata.observed_on_string && metadata.observed_on_string ) {
      unifiedMetadata.observed_on_string = metadata.observed_on_string;
    }
    if ( !unifiedMetadata.positional_accuracy && metadata.positional_accuracy ) {
      unifiedMetadata.positional_accuracy = metadata.positional_accuracy;
    }
  } );

  return unifiedMetadata;
};

export const applyMediaMetadataToObservation = (
  observation: RealmObservationPojo,
  metadata: MediaMetadata,
): RealmObservationPojo => {
  const updatedObservation = observation;

  if ( metadata.latitude && !updatedObservation.latitude ) {
    updatedObservation.latitude = metadata.latitude;
  }
  if ( metadata.longitude && !updatedObservation.longitude ) {
    updatedObservation.longitude = metadata.longitude;
  }
  if ( metadata.observed_on_string && !updatedObservation.observed_on_string ) {
    updatedObservation.observed_on_string = metadata.observed_on_string;
  }
  if ( metadata.positional_accuracy && !updatedObservation.positional_accuracy ) {
    updatedObservation.positional_accuracy = metadata.positional_accuracy;
  }

  return updatedObservation;
};

export const readMetadataFromMovedVideos = async (
  movedVideos: MovedVideoAsset[],
): Promise<MediaMetadata> => readMetadataFromMultipleVideos(
  movedVideos.map( ( { uri, asset } ) => ( {
    uri,
    assetId: asset.id,
  } ) ),
);

export const readMetadataFromMovedPhotosAndVideos = async (
  photoUris: string[],
  movedVideos: MovedVideoAsset[],
): Promise<MediaMetadata> => {
  const photoMetadata = photoUris.length > 0
    ? await readExifFromMultiplePhotos( photoUris )
    : {};
  const videoMetadata = movedVideos.length > 0
    ? await readMetadataFromMovedVideos( movedVideos )
    : {};

  return mergeMediaMetadata( photoMetadata, videoMetadata );
};

const attachVideoSounds = async (
  videoUris: string[],
) => Promise.all(
  videoUris.map( async videoUri => {
    const audioUri = await extractAudioFromVideo( videoUri );
    return ObservationSound.new( audioUri );
  } ),
);

export const createObservationWithVideoSounds = async (
  movedVideos: MovedVideoAsset[],
): Promise<RealmObservationPojo> => {
  const observation = await Observation.new( );
  observation.observationSounds = await attachVideoSounds(
    movedVideos.map( video => video.uri ),
  );

  const metadata = await readMetadataFromMovedVideos( movedVideos );
  return applyMediaMetadataToObservation( observation, metadata );
};

export const createObservationFromGroupedMedia = async (
  group: GroupedMediaItem,
): Promise<RealmObservationPojo> => {
  if ( isVideoGroup( group ) ) {
    return createObservationWithVideoSounds( group.videos || [] );
  }

  if ( isPhotoGroup( group ) ) {
    return Observation.createObservationWithPhotos( group.photos || [] );
  }

  throw new Error( "Grouped media item must include photos or videos" );
};

export const createObservationWithPhotosAndVideoSounds = async (
  photos: { image: Asset }[],
  movedVideos: MovedVideoAsset[],
): Promise<RealmObservationPojo> => {
  let observation = photos.length > 0
    ? await Observation.createObservationWithPhotos( photos )
    : await Observation.new( );

  if ( movedVideos.length > 0 ) {
    observation.observationSounds = await attachVideoSounds(
      movedVideos.map( video => video.uri ),
    );
  }

  const metadata = await readMetadataFromMovedPhotosAndVideos(
    photos.map( photo => photo.image.uri ).filter( Boolean ) as string[],
    movedVideos,
  );

  observation = applyMediaMetadataToObservation( observation, metadata );
  return observation;
};

export const appendVideoSoundsToObservation = async (
  movedVideos: MovedVideoAsset[],
  currentObservation: RealmObservationPojo,
): Promise<RealmObservationPojo> => {
  const observationSounds = await attachVideoSounds(
    movedVideos.map( video => video.uri ),
  );

  let updatedObservation = Observation
    .appendObsSounds( observationSounds, currentObservation );

  const metadata = await readMetadataFromMovedVideos( movedVideos );
  updatedObservation = applyMediaMetadataToObservation(
    updatedObservation,
    metadata,
  );

  return updatedObservation;
};

export const appendPhotosAndVideoSoundsToObservation = async (
  photos: { image: Asset }[],
  movedVideos: MovedVideoAsset[],
  currentObservation: RealmObservationPojo,
  photoPosition: number,
): Promise<RealmObservationPojo> => {
  let updatedObservation = currentObservation;

  if ( photos.length > 0 ) {
    const photoUris = photos.map( photo => photo.image.uri ).filter( Boolean ) as string[];
    const obsPhotos = await ObservationPhoto.createObsPhotosWithPosition(
      photos,
      { position: photoPosition, local: false },
    );

    const unsynced = !currentObservation?._synced_at;
    updatedObservation = unsynced
      ? await Observation.updateObsExifFromPhotos( photoUris, updatedObservation )
      : updatedObservation;
    updatedObservation = Observation.appendObsPhotos( obsPhotos, updatedObservation );
  }

  if ( movedVideos.length > 0 ) {
    const observationSounds = await attachVideoSounds(
      movedVideos.map( video => video.uri ),
    );
    updatedObservation = Observation
      .appendObsSounds( observationSounds, updatedObservation );
  }

  const metadata = await readMetadataFromMovedPhotosAndVideos(
    photos.map( photo => photo.image.uri ).filter( Boolean ) as string[],
    movedVideos,
  );

  return applyMediaMetadataToObservation( updatedObservation, metadata );
};
