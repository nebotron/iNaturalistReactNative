import flatten from "lodash/flatten";
import { useMemo } from "react";
import { useAuthenticatedInfiniteQuery } from "sharedHooks";

const useInfiniteUserScroll = (
  queryKey: string,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  apiCall: Function,
  ids: object[],
  newInputParams: object,
  options: {
    enabled: boolean;
  },
): object => {
  const baseParams = {
    ...newInputParams,
    // TODO: can change this once API pagination is working
    per_page: 200,
  };

  const {
    data,
    isFetching,
    fetchNextPage,
    status,
  } = useAuthenticatedInfiniteQuery(
    [queryKey, baseParams],
    async ( { pageParam }, optsWithAuth ) => {
      const params = {
        ...baseParams,
      };

      if ( pageParam ) {
        params.page = pageParam;
      } else {
        params.page = 1;
      }

      return apiCall( ids, params, optsWithAuth );
    },
    {
      getNextPageParam: lastPage => lastPage.page + 1,
      enabled: options.enabled,
    },
  );

  const pages = data?.pages;
  // Memoised for the same reason as useInfiniteExploreScroll: a fresh array on
  // every render re-renders the whole list.
  const flattenedData = useMemo(
    ( ) => flatten( pages?.map( page => page?.results ) ),
    [pages],
  );

  return {
    data: flattenedData,
    isFetching,
    fetchNextPage,
    status,
    totalResults: pages?.[0]
      ? pages?.[0].total_results
      : null,
  };
};

export default useInfiniteUserScroll;
