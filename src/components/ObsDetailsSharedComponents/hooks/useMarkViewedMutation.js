// @flow
import { useQueryClient } from "@tanstack/react-query";
import {
  markObservationUpdatesViewed,
} from "api/observations";
import {
  useEffect,
  useState,
} from "react";
import Observation from "realmModels/Observation";
import {
  useAuthenticatedMutation,
  useCurrentUser,
  useObservationsUpdates,
} from "sharedHooks";
import { fetchObservationUpdatesKey } from "sharedHooks/useObservationsUpdates";
import useStore from "stores/useStore";

const useMarkViewedMutation = (
  localObservation: Object,
  markViewedLocally: ( ) => void,
  remoteObservation: Object,
) => {
  const currentUser = useCurrentUser( );
  const setObservationMarkedAsViewedAt = useStore(
    state => state.setObservationMarkedAsViewedAt,
  );
  const queryClient = useQueryClient( );
  const [isMarkingViewed, setIsMarkingViewed] = useState( false );

  const observation = localObservation || Observation.mapApiToRealm( remoteObservation );
  const uuid = observation?.uuid;

  const { refetch: refetchObservationUpdates } = useObservationsUpdates(
    !!currentUser && !!observation,
  );

  const { mutate: markViewedMutate } = useAuthenticatedMutation(
    ( viewedParams, optsWithAuth ) => markObservationUpdatesViewed( viewedParams, optsWithAuth ),
    {
      onSuccess: ( ) => {
        if ( localObservation ) {
          markViewedLocally( );
        }
        queryClient.invalidateQueries( { queryKey: [fetchObservationUpdatesKey] } );
        queryClient.invalidateQueries( { queryKey: ["useInfiniteNotificationsScroll"] } );
        refetchObservationUpdates( );
        // Set this value so NotificationsIconContainer knows to update the
        // notifications count
        setObservationMarkedAsViewedAt( new Date( ) );
      },
    },
  );

  useEffect( ( ) => {
    if ( !currentUser ) return;
    if ( !uuid ) return;
    if ( isMarkingViewed ) return;
    if ( localObservation && localObservation.viewed( ) ) return;

    setIsMarkingViewed( true );
    markViewedMutate( { id: uuid } );
  }, [
    currentUser,
    localObservation,
    uuid,
    markViewedMutate,
    isMarkingViewed,
  ] );
};

export default useMarkViewedMutation;
