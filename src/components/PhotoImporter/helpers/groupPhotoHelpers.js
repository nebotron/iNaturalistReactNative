// @flow

const sortByTime = array => array.sort( ( a, b ) => {
  const aTimestamp = a.timestamp || a.asset?.timestamp || a.image?.timestamp || 0;
  const bTimestamp = b.timestamp || b.asset?.timestamp || b.image?.timestamp || 0;
  return bTimestamp - aTimestamp;
} );

export const getGroupTimestamp = group => (
  group.photos?.[0]?.image?.timestamp
  || group.videos?.[0]?.asset?.timestamp
  || 0
);

export const sortGroupsByTime = groups => [...groups].sort(
  ( a, b ) => getGroupTimestamp( b ) - getGroupTimestamp( a ),
);

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
