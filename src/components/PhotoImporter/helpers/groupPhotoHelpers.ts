interface TimedGroup {
  photos?: { image?: { timestamp?: unknown } }[];
  timestamp?: number;
}

const getGroupTimestamp = ( group: TimedGroup ): number => (
  ( group.photos?.[0]?.image?.timestamp as number ) || group.timestamp || 0
);

export const sortGroupsByTime = <T extends TimedGroup>( groups: T[] ): T[] => [...groups].sort(
  ( a, b ) => getGroupTimestamp( b ) - getGroupTimestamp( a ),
);

const flattenAndOrderSelectedPhotos = <P, >(
  selectedObservations?: { photos?: P[] }[],
): P[] => {
  let combinedPhotos: P[] = [];
  selectedObservations?.forEach( obs => {
    combinedPhotos = combinedPhotos.concat( obs.photos || [] );
  } );

  return [...new Set( combinedPhotos )];
};

export default flattenAndOrderSelectedPhotos;
