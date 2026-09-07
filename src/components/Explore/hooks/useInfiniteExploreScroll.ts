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

  // Identity, not contents: excludedUsers is `newInputParams.excludedUsers || []`,
  // so the fallback is a fresh array on every render and can't be a dep itself.
  const excludedIdsKey = excludedUsers.map( u => u.id ).sort( ).join( "," );

  // This used to run in the render body. Every render of the Explore screen —
  // every scroll tick, every filter touch — flattened every page fetched so
  // far, allocated a Set, and walked the whole list twice, then handed the
  // list a *new array identity*, so FlashList re-rendered all of it. Infinite
  // scroll makes that grow without bound, which is what the app log shows:
  // RootExplore is 35 of 85 ui_stall lines and the worst single stall on it is
  // 18.8s, on a screen whose only job while you scroll is to append a page.
  const observations: ApiObservation[] = useMemo( ( ) => {
    const seenKeys = new Set<string | number>( );
    const deduped = ( flatten( pages?.map( r => r.results ) ) || [] ).filter( obs => {
      const key = obs.uuid ?? obs.id;
      if ( key == null || seenKeys.has( key ) ) return false;
      seenKeys.add( key );
      return true;
    } );

    // filter out obs from excluded users (client-side, no API param available)
    if ( excludedUsers.length > 0 ) {
      const excludedIds = new Set( excludedUsers.map( u => u.id ) );
      return deduped.filter( obs => !excludedIds.has( obs?.user?.id ) );
    }
    if ( excludedUser ) {
      return deduped.filter( observation => observation?.user?.id !== excludedUser.id );
    }
    return deduped;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, excludedUser?.id, excludedIdsKey] );

  let totalResults: number | null | undefined = pages?.[0]?.total_results;
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
