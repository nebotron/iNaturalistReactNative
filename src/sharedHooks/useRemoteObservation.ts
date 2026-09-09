import { fetchRemoteObservation } from "api/observations";
import type { ApiObservation } from "api/types";
import i18n from "i18next";
import { RealmContext } from "providers/contexts";
import { useCallback, useEffect, useMemo } from "react";
import Observation from "realmModels/Observation";
import { getCachedObservation } from "sharedHelpers/notificationsCache";
import { useAuthenticatedQuery, useCurrentUser } from "sharedHooks";

const { useRealm } = RealmContext;

export const fetchRemoteObservationKey = "fetchRemoteObservation";

interface UseRemoteObservationReturn {
  remoteObservation: ApiObservation | null | undefined;
  refetchRemoteObservation: () => void;
  isRefetching: boolean;
  fetchRemoteObservationError: Error | null;
}

const useRemoteObservation = ( uuid: string, enabled: boolean ): UseRemoteObservationReturn => {
  const fetchRemoteObservationQueryKey = useMemo(
    ( ) => ( [fetchRemoteObservationKey, uuid] ),
    [uuid],
  );

  const currentUser = useCurrentUser( );
  const realm = useRealm( );

  const locale = i18n?.language ?? "en";

  // An observation the user was notified about was pre-cached to disk while
  // they were online, so opening it offline shows the observation instead of
  // an endless spinner. initialDataUpdatedAt keeps it stale, so a connected
  // screen still refetches immediately.
  const cached = useMemo( ( ) => getCachedObservation( uuid ), [uuid] );

  const {
    data: remoteObservation,
    refetch: refetchRemoteObservation,
    isRefetching,
    error: fetchRemoteObservationError,
  } = useAuthenticatedQuery<ApiObservation | null>(
    fetchRemoteObservationQueryKey,
    optsWithAuth => fetchRemoteObservation(
      uuid,
      {
        include_new_projects: true,
        ...( !currentUser && { locale } ),
        fields: Observation.FIELDS,
      },
      optsWithAuth,
    ),
    {
      enabled: !!( enabled && !!uuid && uuid.length > 0 ),
      initialData: cached?.value,
      initialDataUpdatedAt: cached?.cachedAt,
    },
  );

  const needsLocalUpdate = remoteObservation
    && currentUser
    && remoteObservation?.user?.id === currentUser.id;

  const updateLocalObservation = useCallback( ( ) => {
    Observation.upsertRemoteObservations(
      [remoteObservation],
      realm,
    );
  }, [remoteObservation, realm] );

  // Update local copy of a user's own observation
  useEffect( ( ) => {
    if ( needsLocalUpdate ) {
      updateLocalObservation( );
    }
  }, [
    needsLocalUpdate,
    updateLocalObservation,
  ] );

  return {
    remoteObservation,
    refetchRemoteObservation,
    isRefetching,
    fetchRemoteObservationError,
  };
};

export default useRemoteObservation;
