import { useQuery } from "@tanstack/react-query";
import type { NearbyCoords } from "components/Explore/ExploreV2/helpers/buildQueryParams";
import { excludesSpecies } from "components/Explore/ExploreV2/helpers/buildQueryParams";
import {
  referencedSavedSearches,
  resolveExcludedSpeciesIds,
} from "components/Explore/ExploreV2/helpers/excludedSpecies";
import savedSearchKey from "components/Explore/ExploreV2/helpers/savedSearchKey";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import type { ExploreV2Search } from "providers/ExploreV2Context";
import { defaultExploreV2Filters } from "providers/ExploreV2Context";
import useStore from "stores/useStore";

// Please don't change these to aliased paths or the e2e mocks will not get used
import fetchCoarseUserLocation from "../../../../sharedHelpers/fetchCoarseUserLocation";
import { getLatestTrackedLocation } from "../../../../sharedHelpers/locationHistoryTracker";

interface Options {
  // Re-resolve each time a search is applied, not just on mount
  searchCount: number;
  // A saved search's species can't be loaded offline
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

export const fetchNearbyCoords = async ( ): Promise<NearbyCoords | undefined> => {
  const location = await getLatestTrackedLocation( ) ?? await fetchCoarseUserLocation( );
  return typeof location?.latitude === "number"
    ? { lat: location.latitude, lng: location.longitude }
    : undefined;
};

// The species a search leaves out (see excludedSpecies), fetched again each
// time the search is applied so they're up to date
const useExcludedSpecies = (
  search: Pick<ExploreV2Search, "filters">,
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

  const {
    data, error, isFetchedAfterMount, isFetching,
  } = useQuery( {
    // The key holds the referenced saved searches rather than all of them, so
    // editing an unrelated one doesn't re-resolve
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: [
      "excludedSpecies",
      savedSearchName,
      referenced,
      searchCount,
      offline,
      currentUserId,
      nearbyCoords?.lat,
      nearbyCoords?.lng,
    ],
    queryFn: async ( ) => {
      // Without a token the species are fetched signed out
      const apiToken = offline
        ? null
        : await getJWT( ).catch( ( ) => null );
      // Rebuilt from the key, so only what the key covers can change the result
      return resolveExcludedSpeciesIds( {
        filters: { ...defaultExploreV2Filters, excludeSpeciesInSavedSearch: savedSearchName },
      }, {
        savedSearches,
        apiToken,
        currentUserId,
        offline,
        getNearbyCoords: async ( ) => nearbyCoords ?? fetchNearbyCoords( ),
      } );
    },
    enabled: active && enabled,
    refetchOnMount: "always",
    gcTime: 0,
    // A missing saved search won't appear on a retry
    retry: false,
  } );

  const settled = isFetchedAfterMount && !isFetching;
  return {
    active,
    ids: settled && !error
      ? data
      : undefined,
    error: settled
      ? error
      : null,
  };
};

export default useExcludedSpecies;
