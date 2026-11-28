// @flow

import { useMemo } from "react";
import { useAuthenticatedInfiniteQuery } from "sharedHooks";

const useInfiniteScroll = (
  queryKey: string,
  apiCall: Function,
  newInputParams: Object,
  options?: {
    enabled: boolean,
    // Keep the results on disk, as Explore does; see useAuthenticatedInfiniteQuery
    persist?: boolean,
    // Show results from the HTTP cache at once and fetch the latest in the
    // background; see useAuthenticatedInfiniteQuery
    cacheFirst?: boolean
  },
): Object => {
  const baseParams = {
    per_page: 20,
    ttl: -1,
    ...newInputParams,
  };

  const {
    data,
    dataUpdatedAt,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    refetch,
    refreshFirstPage,
    status,
  } = useAuthenticatedInfiniteQuery(
    [queryKey, baseParams],
    async ( { pageParam = 1 }, optsWithAuth ) => {
      const params = {
        ...baseParams,
      };

      params.page = pageParam;

      return apiCall( params, optsWithAuth );
    },
    // TO DO: we need to properly type queryOptions in useAuthenticatedInfiniteQuery
    /* eslint-disable consistent-return */
    {
      getNextPageParam: lastPage => {
        if ( !lastPage ) return undefined;

        const totalResultsCount = lastPage.total_results;
        const totalFetchedCount = lastPage.page * baseParams.per_page;

        return totalFetchedCount < totalResultsCount
          ? lastPage.page + 1
          : undefined;
      },

      enabled: options?.enabled,
      persist: options?.persist,
      cacheFirst: options?.cacheFirst,
    },
    /* eslint-enable consistent-return */
  );

  const pages = data?.pages || [];
  // Memoized so lists sorted on device (e.g. Explore species in taxonomic order) only re-sort
  // when a page arrives
  const allResults = useMemo(
    ( ) => ( data?.pages || [] ).map( page => page?.results ).flat( Infinity ).filter( Boolean ),
    [data?.pages],
  );

  return {
    data: allResults,
    dataUpdatedAt,
    isFetching,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
    refetch,
    // Goes to the network and keeps the results shown until it works; see
    // useAuthenticatedInfiniteQuery
    refreshFirstPage,
    status,
    totalResults: pages?.[0]
      ? pages?.[0].total_results
      : null,
  };
};

export default useInfiniteScroll;
