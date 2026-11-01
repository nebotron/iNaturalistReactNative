import { RealmContext } from "providers/contexts";
import { useMemo } from "react";
import Observation from "realmModels/Observation";
import type { MyObservationsSort } from "sharedHelpers/observationsSort";
import {
  OBSERVATIONS_SORT,
  observationSortToRealmSort,
} from "sharedHelpers/observationsSort";
import useSubjectDistances, { sortBySubjectDistance } from "sharedHooks/useSubjectDistances";

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
        ? ["uuid", "_created_at", "observed_on_string"]
        : ["uuid"],
    },
    [sortBy],
  );

  const bySubjectDistance = sortBy === OBSERVATIONS_SORT.SUBJECT_DISTANCE_NEAREST;
  const subjectDistances = useSubjectDistances( bySubjectDistance );

  return useMemo( ( ) => {
    const ids = unsyncedObs.map( ( { uuid }: { uuid: string } ) => ( { uuid } ) );
    return bySubjectDistance
      ? sortBySubjectDistance( ids, subjectDistances )
      : ids;
  }, [unsyncedObs, bySubjectDistance, subjectDistances] );
};

export default useLocalObservationIds;
