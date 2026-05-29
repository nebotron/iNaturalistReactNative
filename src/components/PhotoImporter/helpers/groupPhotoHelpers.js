// @flow

import Observation from "realmModels/Observation";

const sortByTime = array => array.sort( ( a, b ) => {
  const aTimestamp = a.timestamp || a.asset?.timestamp || 0;
  const bTimestamp = b.timestamp || b.asset?.timestamp || 0;
  return bTimestamp - aTimestamp;
} );

const dedupePhotos = photos => [...new Set( photos )];

const dedupeVideos = videos => {
  const seenUris = new Set( );
  return videos.filter( video => {
    if ( seenUris.has( video.uri ) ) {
      return false;
    }
    seenUris.add( video.uri );
    return true;
  } );
};

const flattenAndOrderSelectedPhotos = ( selectedObservations: ?Object[] ): Object[] => {
  let combinedPhotos = [];
  selectedObservations?.forEach( obs => {
    combinedPhotos = combinedPhotos.concat( obs.photos || [] );
  } );

  return dedupePhotos( sortByTime( combinedPhotos ) );
};

export const flattenAndOrderSelectedVideos = (
  selectedObservations: ?Object[],
): Object[] => {
  let combinedVideos = [];
  selectedObservations?.forEach( obs => {
    combinedVideos = combinedVideos.concat( obs.videos || [] );
  } );

  return dedupeVideos( sortByTime( combinedVideos ) );
};

export const selectedGroupsHaveMixedMedia = (
  selectedObservations: ?Object[],
): boolean => {
  const hasPhotos = selectedObservations?.some(
    obs => obs.photos?.length > 0,
  );
  const hasVideos = selectedObservations?.some(
    obs => obs.videos?.length > 0,
  );

  return Boolean( hasPhotos && hasVideos );
};

export const groupContainsPhoto = ( obs: Object, photo: Object ): boolean => (
  obs.photos?.includes( photo )
);

export const groupContainsVideo = ( obs: Object, video: Object ): boolean => (
  obs.videos?.some( item => item.uri === video.uri )
);

export default flattenAndOrderSelectedPhotos;

export const isVideoGroup = ( group: Object ): boolean => (
  ( group.videos?.length || 0 ) > 0
);

export const isPhotoGroup = ( group: Object ): boolean => (
  ( group.photos?.length || 0 ) > 0
);

export const createObservationFromGroupedMedia = async (
  group: Object,
): Promise<Object> => {
  if ( isVideoGroup( group ) ) {
    throw new Error( "Video groups are not supported in group photo helpers" );
  }
  if ( isPhotoGroup( group ) ) {
    return Observation.createObservationWithPhotos( group.photos || [] );
  }
  throw new Error( "Grouped media item must include photos or videos" );
};
