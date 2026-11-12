import { syncResearchGradeSpeciesIds } from "components/Explore/helpers/withoutObservedSpecies";
import useAuthenticatedQuery from "sharedHooks/useAuthenticatedQuery";

interface ObservedSpeciesSync {
  // The user's research-grade species, from a sync that finished after this
  // screen mounted (or the search was last applied). Undefined until then.
  observedSpeciesIds?: number[];
  isError: boolean;
  retry: ( ) => void;
}

// Brings the user's observation history up to date before "Unobserved by me"
// is applied, so a species they've observed since the last sync isn't shown as
// unobserved. Never reports cached ids: results must wait for this, or fail.
const useObservedSpeciesSync = (
  userId: number | undefined,
  // Re-sync each time a search is applied, not just on mount
  searchCount: number,
): ObservedSpeciesSync => {
  const {
    data, isError, isFetchedAfterMount, isFetching, isSuccess, refetch,
  } = useAuthenticatedQuery(
    ["observedResearchGradeSpecies", userId, searchCount],
    optsWithAuth => syncResearchGradeSpeciesIds( userId as number, optsWithAuth ),
    {
      enabled: !!userId,
      requireLoggedIn: true,
      refetchOnMount: "always",
      gcTime: 0,
      // The error screen has its own retry button; backing off silently would
      // leave a spinner up for a long time instead
      retry: false,
    },
  );
  const isFresh = isSuccess && isFetchedAfterMount && !isFetching;
  return {
    observedSpeciesIds: isFresh
      ? data
      : undefined,
    isError: !!userId && isError && !isFetching,
    retry: ( ) => { refetch( ); },
  };
};

export default useObservedSpeciesSync;
