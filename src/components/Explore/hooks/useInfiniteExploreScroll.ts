import type { QueryStatus } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { searchObservations } from "api/observations";
import type {
  ApiObservation,
  ApiObservationsSearchParams,
  ApiObservationsSearchResponse,
  ApiTotalBounds,
} from "api/types";
import flatten from "lodash/flatten";
import { useCallback, useMemo } from "react";
import Observation from "realmModels/Observation";
import ObservationSound from "realmModels/ObservationSound";
import { useAuthenticatedInfiniteQuery } from "sharedHooks";

import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "../helpers/exploreParams";

interface ExcludeUser {
  id: number;
}

interface UseInfiniteExploreScrollParams {
  params: ApiObservationsSearchParams & {
    excludeUser?: ExcludeUser;
    excludedUsers?: ExcludeUser[];
  };
  enabled: boolean;
}

interface UseInfiniteExploreScrollReturn {
  fetchNextPage: ( ) => void;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  handlePullToRefresh: ( ) => Promise<void>;
  observations: ApiObservation[];
  status: QueryStatus;
  totalBounds: ApiTotalBounds | undefined;
  totalResults: number | null;
}

const useInfiniteExploreScroll = (
  { params: newInputParams, enabled }: UseInfiniteExploreScrollParams,
): UseInfiniteExploreScrollReturn => {
  const queryClient = useQueryClient( );

  const baseParams = useMemo( () => ( {
    ...newInputParams,
    fields: {
      // the most data we display in the UI on any Observations view in Explore
      // is the same amount of data we show for the Advanced list mode in MyObservations
      ...Observation.ADVANCED_MODE_LIST_FIELDS,
      // geojson is the reliable coordinate source on API observations (top-level
      // latitude/longitude are often absent); the Identify auto-CV reads it to
      // score with location, matching the Suggest ID screen.
      geojson: true,
      // ADVANCED_MODE_LIST_FIELDS only asks for the sound uuid, but the Identify
      // view plays the sounds of observations that have no photos.
      observation_sounds: ObservationSound.OBSERVATION_SOUNDS_FIELDS,
      user: { // included here for "exclude by current user" in explore filters
        id: true,
        uuid: true,
        login: true,
      },
    },
    ttl: -1,
  } ), [newInputParams] );

  const excludedUser: ExcludeUser | undefined = newInputParams.excludeUser;
  const excludedUsers: ExcludeUser[] = newInputParams.excludedUsers || [];

  const queryKey = ["useInfiniteExploreScroll", newInputParams];

  const getNextPageParam = useCallback(
    ( lastPage: ApiObservationsSearchResponse ) => getNextPageParamForExplore(
      lastPage,
      baseParams,
    ),
    [baseParams],
  );

  const {
    data,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    refetch,
    isRefetching,
    status,
  } = useAuthenticatedInfiniteQuery(
    queryKey,
    async ( params, optsWithAuth ) => searchObservations(
      addPageParamsForExplore( { ...baseParams, ...params } ),
      optsWithAuth,
    ),
    {
      getNextPageParam,
      enabled,
    },
  );

  const handlePullToRefresh = async ( ) => {
    queryClient.removeQueries( { queryKey } );
    await refetch( );
  };

  const pages = data?.pages as ApiObservationsSearchResponse[] | undefined;

  const allObservations: ApiObservation[] = flatten( pages?.map( r => r.results ) ) || [];
  const seenKeys = new Set<string | number>();
  let observations: ApiObservation[] = allObservations.filter( obs => {
    const key = obs.uuid ?? obs.id;
    if ( key == null || seenKeys.has( key ) ) return false;
    seenKeys.add( key );
    return true;
  } );
  let totalResults: number | null | undefined = pages?.[0]?.total_results;
  let filtered = [];

  // filter out obs from excluded users (client-side, no API param available)
  if ( excludedUsers.length > 0 && observations ) {
    const excludedIds = new Set( excludedUsers.map( u => u.id ) );
    filtered = observations.filter( obs => !excludedIds.has( obs?.user?.id ) );
    observations = filtered;
  } else if ( excludedUser && observations ) {
    filtered = observations.filter( observation => observation?.user?.id !== excludedUser.id );
    observations = filtered;
  }

  if ( totalResults !== 0 && !totalResults ) {
    totalResults = null;
  }

  return {
    fetchNextPage,
    isLoading,
    isFetchingNextPage: isFetchingNextPage || isRefetching,
    handlePullToRefresh,
    observations,
    status,
    totalBounds: pages?.[0]?.total_bounds,
    totalResults,
  };
};

export default useInfiniteExploreScroll;
