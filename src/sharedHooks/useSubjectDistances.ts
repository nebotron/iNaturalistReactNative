import { RealmContext } from "providers/contexts";
import { useMemo } from "react";
import type { RealmObservation } from "realmModels/types";
import useBackfillCameraInfo from "sharedHooks/useBackfillCameraInfo";

const { useQuery } = RealmContext;

// Distance to subject in meters of an observation's first photo, from its
// cached camera info, or Infinity when there's no data
const subjectDistance = ( observation: RealmObservation ): number => {
  try {
    const raw = observation.observationPhotos?.[0]?.cameraInfo;
    const distance = parseFloat( raw
      ? JSON.parse( raw ).focusDistance
      : "" );
    return distance > 0
      ? distance
      : Infinity;
  } catch {
    return Infinity;
  }
};

// Nearest subject first; stable, so ties (including no data) keep their order
export const sortBySubjectDistance = <T extends { uuid: string }>(
  items: T[],
  distances: Map<string, number>,
): T[] => items
  .map( item => ( { item, distance: distances.get( item.uuid ) ?? Infinity } ) )
  .sort( ( a, b ) => ( a.distance === b.distance
    ? 0
    : a.distance - b.distance ) )
  .map( ( { item } ) => item );

// Index of uuid → distance to subject for the user's local observations.
// Camera info is cached in Realm, and backfilled from library originals when
// enabled, so EXIF is read at most once per photo.
const useSubjectDistances = ( enabled: boolean ): Map<string, number> => {
  const observations = useQuery<RealmObservation>(
    {
      type: "Observation",
      query: obs => obs.filtered( enabled
        ? "observationPhotos.@count > 0"
        : "FALSEPREDICATE" ),
      keyPaths: ["uuid", "observationPhotos.cameraInfo"],
    },
    [enabled],
  );
  useBackfillCameraInfo( observations );
  return useMemo( ( ) => {
    const distances = new Map<string, number>( );
    observations.forEach( observation => {
      const distance = subjectDistance( observation );
      if ( distance < Infinity ) distances.set( observation.uuid, distance );
    } );
    return distances;
  }, [observations] );
};

export default useSubjectDistances;
