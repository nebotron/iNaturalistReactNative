import type { QueryStatus } from "@tanstack/react-query";
import { searchObservations } from "api/observations";
import type {
  ApiObservation,
  ApiObservationsSearchParams,
  ApiObservationsSearchResponse,
  ApiTotalBounds,
} from "api/types";
import flatten from "lodash/flatten";
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import Observation from "realmModels/Observation";
import Vote from "realmModels/Vote";
import { log } from "sharedHelpers/logger";
import { useAuthenticatedInfiniteQuery } from "sharedHooks";

import {
  addPageParamsForExplore,
  getNextPageParamForExplore,
} from "../helpers/exploreParams";

const logger = log.extend( "useInfiniteExploreScroll" );

// The API can't filter by who faved an observation, so a faved_by search asks
// for popular observations (faved by anyone) and keeps this user's faves here.
// It scans in the biggest pages the API returns...
const FAVED_BY_PER_PAGE = 200;
// ...until a load shows this many more of them...
const FAVED_BY_BATCH = 20;
// ...or this many pages went by without enough, so a broad search doesn't
// page through millions of observations; scrolling to the end scans on.
const FAVED_BY_MAX_PAGES_PER_BATCH = 10;

export const isFavedBy = ( observation: ApiObservation, userId: number ) => (
  observation.votes || []
).some( vote => !vote.vote_scope && vote.user_id === userId );

interface UseInfiniteExploreScrollParams {
  params: ApiObservationsSearchParams;
  enabled: boolean;
  // Only ever show results just fetched from the network, never cached ones
  noCache?: boolean;
}

interface UseInfiniteExploreScrollReturn {
  error: unknown;
  fetchStatus: string;
  fetchNextPage: ( ) => void;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  handlePullToRefresh: ( ) => Promise<void>;
  observations: ApiObservation[];
  status: QueryStatus;
  totalBounds: ApiTotalBounds | undefined;
  totalResults: number | null;
}

const useInfiniteExploreScroll = (
  { params: newInputParams, enabled, noCache = false }: UseInfiniteExploreScrollParams,
): UseInfiniteExploreScrollReturn => {
  const favedBy = typeof newInputParams.faved_by === "number"
    ? newInputParams.faved_by
    : null;
  const baseParams = useMemo( () => {
    // Not an API param; applied below
    const { faved_by: _favedBy, ...apiParams } = newInputParams;
    return {
      ...apiParams,
      ...( _favedBy != null && { per_page: FAVED_BY_PER_PAGE } ),
      // Only what Explore's list, grid and Identify views draw. ObsDetails gets
      // these as its preloaded observation and fetches the rest itself.
      fields: {
        ...Observation.DEFAULT_MODE_LIST_FIELDS,
        taxon: {
          ...Observation.DEFAULT_MODE_LIST_FIELDS.taxon,
          // For sorting in taxonomic order
          ancestor_ids: true,
        },
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
        // ObsGridItem's fave star and fave count
        votes: Vote.VOTE_FIELDS,
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
    };
  }, [newInputParams] );

  // Kept apart from the cached query for the same search
  const queryKey = noCache
    ? ["useInfiniteExploreScroll", "noCache", newInputParams]
    : ["useInfiniteExploreScroll", newInputParams];

  const getNextPageParam = useCallback(
    ( lastPage: ApiObservationsSearchResponse ) => getNextPageParamForExplore(
      lastPage,
      baseParams,
    ),
    [baseParams],
  );

  const {
    data,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    fetchNextPage,
    refreshFirstPage,
    isRefetching,
    status,
    error,
    fetchStatus,
  } = useAuthenticatedInfiniteQuery(
    queryKey,
    async ( params, optsWithAuth ) => searchObservations(
      addPageParamsForExplore( { ...baseParams, ...params } ),
      optsWithAuth,
    ),
    {
      getNextPageParam,
      enabled,
      // Shown again after leaving Explore or restarting the app, while the
      // latest are fetched in the background
      persist: !noCache,
      noCache,
    },
  );

  // The results already shown stay while the new ones load, and if they
  // can't be fetched
  const handlePullToRefresh = useCallback( async ( ) => {
    try {
      await refreshFirstPage( );
    } catch ( error ) {
      logger.warn( "Pull to refresh failed, keeping the results shown", error );
    }
  }, [refreshFirstPage] );

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
    return favedBy == null
      ? deduped
      : deduped.filter( obs => isFavedBy( obs, favedBy ) );
  }, [pages, favedBy] );

  // For faved_by, how many matches to show and how many pages had loaded when
  // that was asked for; reset when the search changes
  const [favedByBatch, setFavedByBatch] = useState( {
    params: newInputParams,
    wanted: FAVED_BY_BATCH,
    fromPage: 0,
  } );
  const isCurrentBatch = favedByBatch.params === newInputParams;
  const wanted = isCurrentBatch
    ? favedByBatch.wanted
    : FAVED_BY_BATCH;
  const fromPage = isCurrentBatch
    ? favedByBatch.fromPage
    : 0;
  const pageCount = pages?.length ?? 0;
  const requestedAtPageRef = useRef<number | null>( null );
  useEffect( ( ) => {
    if ( favedBy == null || !enabled ) {
      requestedAtPageRef.current = null;
      return;
    }
    // Wait for the first page, and don't retry a page that failed
    if ( pageCount === 0 || !hasNextPage || isFetchingNextPage || error ) return;
    if ( observations.length >= wanted ) return;
    if ( pageCount - fromPage >= FAVED_BY_MAX_PAGES_PER_BATCH ) return;
    if ( requestedAtPageRef.current === pageCount ) return;
    requestedAtPageRef.current = pageCount;
    fetchNextPage( );
  }, [
    favedBy,
    enabled,
    pageCount,
    hasNextPage,
    isFetchingNextPage,
    error,
    observations.length,
    wanted,
    fromPage,
    fetchNextPage,
  ] );

  const fetchMore = useCallback( ( ) => {
    if ( favedBy != null ) {
      setFavedByBatch( {
        params: newInputParams,
        wanted: observations.length + FAVED_BY_BATCH,
        fromPage: pageCount,
      } );
      requestedAtPageRef.current = null;
      return;
    }
    fetchNextPage( );
  }, [favedBy, newInputParams, observations.length, pageCount, fetchNextPage] );

  let totalResults: number | null | undefined = pages?.[0]?.total_results;
  if ( favedBy != null ) {
    // Only known once every popular observation has been checked
    totalResults = pages && !hasNextPage
      ? observations.length
      : null;
  }
  if ( totalResults !== 0 && !totalResults ) {
    totalResults = null;
  }

  return {
    error,
    fetchStatus,
    fetchNextPage: fetchMore,
    hasNextPage,
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
