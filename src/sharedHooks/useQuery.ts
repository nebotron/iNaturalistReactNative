import type { QueryFunction } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";

// Should work like React Query's useQuery with our custom reactQueryRetry
const useNonAuthenticatedQuery = (
  queryKey: string[],
  queryFunction: QueryFunction,
  queryOptions: object = {},
) => useQuery( {
  queryKey: [...queryKey, queryOptions.allowAnonymousJWT],
  queryFn: queryFunction,
  ...queryOptions,
} );

export default useNonAuthenticatedQuery;
