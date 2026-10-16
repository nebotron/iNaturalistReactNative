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
import { useAuthenticatedInfiniteQuery } from "sharedHooks";

import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "../helpers/exploreParams";

interface UseInfiniteExploreScrollParams {
  params: ApiObservationsSearchParams;
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
    // Only what Explore's list, grid and Identify views draw. ObsDetails gets
    // these as its preloaded observation and fetches the rest itself.
    fields: {
      ...Observation.DEFAULT_MODE_LIST_FIELDS,
      // ObsStatus's identification and comment counts
      identifications: Observation.ADVANCED_MODE_LIST_FIELDS.identifications,
      comments: { uuid: true },
      // ObsListItem's location and date
      geoprivacy: true,
      obscured: true,
      observed_on: true,
      observed_time_zone: true,
      place_guess: true,
      private_place_guess: true,
      private_geojson: true,
      taxon_geoprivacy: true,
      // geojson is the reliable coordinate source on API observations (top-level
      // latitude/longitude are often absent); the Identify auto-CV reads it to
      // score with location, matching the Suggest ID screen.
      geojson: true,
      // login is needed so ObsListItem can tell whether an observation belongs
      // to the current user (geoprivacy/obscured handling differs in that case)
      user: {
        id: true,
        uuid: true,
        login: true,
      },
    },
    ttl: -1,
  } ), [newInputParams] );

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

  // Memoized so a render doesn't re-flatten every page fetched so far and hand
  // FlashList a new array identity, which re-renders the whole list.
  const observations: ApiObservation[] = useMemo( ( ) => {
    const seenKeys = new Set<string | number>( );
    const deduped = ( flatten( pages?.map( r => r.results ) ) || [] ).filter( obs => {
      const key = obs.uuid ?? obs.id;
      if ( key == null || seenKeys.has( key ) ) return false;
      seenKeys.add( key );
      return true;
    } );
    return deduped;
  }, [pages] );

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
