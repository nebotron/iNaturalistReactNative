import { RealmContext } from "providers/contexts";
import { useMemo } from "react";
import Observation from "realmModels/Observation";
import type { MyObservationsSort } from "sharedHelpers/observationsSort";
import {
  OBSERVATIONS_SORT,
  observationSortToRealmSort,
} from "sharedHelpers/observationsSort";

// Distance to subject in meters from the first photo's stored camera info, else Infinity
const subjectDistance = (
  observation: { observationPhotos?: ArrayLike<{ cameraInfo?: string | null }> },
): number => {
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

const { useQuery } = RealmContext;

const useLocalObservationIds = ( sortBy?: MyObservationsSort ) => {
  const unsyncedObs = useQuery(
    {
      type: Observation,
      query: observations => observations
        .filtered( "_deleted_at == nil OR _pending_deletion == false OR _pending_deletion == nil" )
        .sorted( sortBy
          ? [observationSortToRealmSort( sortBy )]
          : [["_created_at", true]] ),
      // widening this beyond uuid means more frequent re-renders for every consumer,
      // so we only do it when we need a local sort applied to the results
      keyPaths: sortBy
        ? ["uuid", "_created_at", "observed_on_string", "observationPhotos.cameraInfo"]
        : ["uuid"],
    },
    [sortBy],
  );

  return useMemo( ( ) => {
    if ( sortBy !== OBSERVATIONS_SORT.SUBJECT_DISTANCE_NEAREST ) {
      return unsyncedObs.map( ( { uuid }: { uuid: string } ) => ( { uuid } ) );
    }
    // Array.sort is stable, so ties (including no data) keep newest-first order
    return Array.from( unsyncedObs )
      .map( observation => ( {
        uuid: observation.uuid,
        distance: subjectDistance( observation ),
      } ) )
      .sort( ( a, b ) => ( a.distance === b.distance
        ? 0
        : a.distance - b.distance ) )
      .map( ( { uuid } ) => ( { uuid } ) );
  }, [sortBy, unsyncedObs] );
};

export default useLocalObservationIds;
