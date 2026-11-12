import { useQuery } from "@tanstack/react-query";
import { syncResearchGradeSpeciesIds } from "components/Explore/helpers/withoutObservedSpecies";
import { getJWT } from "components/LoginSignUp/AuthenticationService";

// The user's research-grade species for "Unobserved by me", from a sync that
// ran after this screen mounted (or the search was last applied), so a species
// observed since the last sync is hidden too. Offline, or if the sync fails,
// it's the previous list. Undefined until then.
const useObservedSpeciesSync = (
  userId: number | undefined,
  // Re-sync each time a search is applied, not just on mount
  searchCount: number,
  // Skip the request and use the previous list straight away
  offline: boolean,
): number[] | undefined => {
  const { data, isFetchedAfterMount, isFetching } = useQuery( {
    queryKey: ["observedResearchGradeSpecies", userId, searchCount, offline],
    queryFn: async ( ) => {
      // A token that can't be refreshed just fails the sync, which falls back
      const apiToken = offline
        ? null
        : await getJWT( ).catch( ( ) => null );
      return syncResearchGradeSpeciesIds(
        userId as number,
        { api_token: apiToken },
        { offline },
      );
    },
    enabled: !!userId,
    refetchOnMount: "always",
    gcTime: 0,
    // Failures already fall back to the previous list
    retry: false,
  } );
  return isFetchedAfterMount && !isFetching
    ? data
    : undefined;
};

export default useObservedSpeciesSync;
