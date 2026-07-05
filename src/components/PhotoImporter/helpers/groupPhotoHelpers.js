// @flow

const sortByTime = array => array.sort( ( a, b ) => {
  const aTimestamp = a.timestamp || a.asset?.timestamp || a.image?.timestamp || 0;
  const bTimestamp = b.timestamp || b.asset?.timestamp || b.image?.timestamp || 0;
  return bTimestamp - aTimestamp;
} );

export const getGroupTimestamp = ( group: Object ): number => (
  group.photos?.[0]?.image?.timestamp || 0
);

export const sortGroupsByTime = ( groups: Object[] ): Object[] => [...groups].sort(
  ( a, b ) => getGroupTimestamp( b ) - getGroupTimestamp( a ),
);

const dedupePhotos = photos => [...new Set( photos )];

const flattenAndOrderSelectedPhotos = ( selectedObservations: ?Object[] ): Object[] => {
  let combinedPhotos = [];
  selectedObservations?.forEach( obs => {
    combinedPhotos = combinedPhotos.concat( obs.photos || [] );
  } );

  return dedupePhotos( sortByTime( combinedPhotos ) );
};

export const groupContainsPhoto = ( obs: Object, photo: Object ): boolean => (
  obs.photos?.includes( photo )
);

export default flattenAndOrderSelectedPhotos;
