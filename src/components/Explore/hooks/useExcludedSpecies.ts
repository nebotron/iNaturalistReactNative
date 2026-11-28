import { useQuery } from "@tanstack/react-query";
import type { NearbyCoords } from "components/Explore/helpers/buildQueryParams";
import { excludesSpecies } from "components/Explore/helpers/buildQueryParams";
import {
  ExcludedSavedSearchError,
  referencedSavedSearches,
  resolveExcludedSpeciesIds,
} from "components/Explore/helpers/excludedSpecies";
import savedSearchKey from "components/Explore/helpers/savedSearchKey";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type { ExploreSearch } from "providers/ExploreContext";
import { defaultExploreFilters } from "providers/ExploreContext";
import { useEffect, useState } from "react";
import {
  PERSISTED_QUERY_META,
  PERSISTED_QUERY_TTL_MS,
  readPersistedQuery,
  readPersistedQueryUpdatedAt,
} from "sharedHelpers/persistedQueries";
import useStore from "stores/useStore";

// Please don't change these to aliased paths or the e2e mocks will not get used
import fetchCoarseUserLocation from "../../../sharedHelpers/fetchCoarseUserLocation";
import { getLatestTrackedLocation } from "../../../sharedHelpers/locationHistoryTracker";

interface Options {
  // Re-resolve each time a search is applied, not just on mount
  searchCount: number;
  // Offline, a saved search's species come from the HTTP cache, or failing
  // that, the ones last resolved
  offline: boolean;
  // Nearby for the current search, also used for a nearby saved search
  nearbyCoords?: NearbyCoords;
  currentUserId?: number | null;
  enabled?: boolean;
}

interface ExcludedSpecies {
  // Whether the search leaves any species out at all
  active: boolean;
  // Undefined until resolved after this screen mounted (or the search was last
  // applied), or when resolving failed
  ids?: number[];
  // Why they couldn't be resolved, e.g. a MissingSavedSearchError
  error: Error | null;
}

const fetchNearbyCoords = async ( ): Promise<NearbyCoords | undefined> => {
  const location = await getLatestTrackedLocation( ) ?? await fetchCoarseUserLocation( );
  return typeof location?.latitude === "number"
    ? { lat: location.latitude, lng: location.longitude }
    : undefined;
};

// Failures the saved species can stand in for: being offline or the request
// failing, rather than the search itself being unresolvable
const canUseSavedSpecies = ( error: Error ) => !( error instanceof ExcludedSavedSearchError )
  || error.reason === "offline";

// The species a search leaves out (see excludedSpecies), fetched again each
// time the search is applied so they're up to date
const useExcludedSpecies = (
  search: Pick<ExploreSearch, "filters">,
  {
    searchCount, offline, nearbyCoords, currentUserId, enabled = true,
  }: Options,
): ExcludedSpecies => {
  const savedSearches = useStore( state => state.exploreSavedSearches.searches );
  const active = excludesSpecies( search );
  const savedSearchName = search.filters.excludeSpeciesInSavedSearch ?? null;
  // Editing, renaming or deleting a referenced saved search changes the key
  const referenced = referencedSavedSearches( search, savedSearches )
    .map( saved => `${saved.name}:${savedSearchKey( saved )}` );

  // What the exclusion is. Where Nearby is, whether the app is offline and
  // how many times the search was applied only change when it's fetched again,
  // so the results saved for it are found again, offline too, after leaving
  // Explore (e.g. for Audio ID) or restarting
  const queryKey = [
    "excludedSpecies",
    savedSearchName,
    referenced,
    currentUserId,
  ];
  const refetchWhen = JSON.stringify( [
    searchCount,
    offline,
    nearbyCoords?.lat,
    nearbyCoords?.lng,
  ] );
  const [fetchedFor, setFetchedFor] = useState( refetchWhen );
  // Until the refetch below starts, what's shown is for the old ones
  const refetchPending = fetchedFor !== refetchWhen;

  const {
    data, error, isFetchedAfterMount, isFetching, refetch,
  } = useQuery( {
    // The key holds the referenced saved searches rather than all of them, so
    // editing an unrelated one doesn't re-resolve
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey,
    queryFn: async ( ) => {
      // Offline too, so the request matches the one cached when the user
      // last viewed the search
      const apiToken = await getJWT( ).catch( ( ) => null );
      // Rebuilt from the key and what refetches it, so nothing else can
      // change the result
      return resolveExcludedSpeciesIds( {
        filters: { ...defaultExploreFilters, excludeSpeciesInSavedSearch: savedSearchName },
      }, {
        savedSearches,
        apiToken,
        currentUserId,
        offline,
        getNearbyCoords: async ( ) => nearbyCoords ?? fetchNearbyCoords( ),
      } );
    },
    enabled: active && enabled,
    // Resolved again each time Explore opens, showing nothing until then, so
    // the saved copy only stands in when that fails
    refetchOnMount: "always",
    meta: PERSISTED_QUERY_META,
    gcTime: PERSISTED_QUERY_TTL_MS,
    initialData: ( ) => readPersistedQuery( queryKey ) as number[] | undefined,
    initialDataUpdatedAt: ( ) => readPersistedQueryUpdatedAt( queryKey ),
    // A missing saved search won't appear on a retry
    retry: false,
  } );

  useEffect( ( ) => {
    if ( !refetchPending ) return;
    setFetchedFor( refetchWhen );
    if ( active && enabled ) refetch( );
  }, [refetchPending, refetchWhen, active, enabled, refetch] );

  const settled = isFetchedAfterMount && !isFetching && !refetchPending;
  // Offline or when the request fails, the species resolved last time, as
  // React Query keeps them, rather than an error
  const usable = !error || ( data && canUseSavedSpecies( error ) );
  return {
    active,
    ids: settled && usable
      ? data
      : undefined,
    error: settled && !usable
      ? error
      : null,
  };
};

export default useExcludedSpecies;
