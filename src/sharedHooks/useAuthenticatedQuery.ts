import type { QueryKey, UseQueryOptions } from "@tanstack/react-query";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { getJWT, isLoggedIn } from "components/LoginSignUp/AuthenticationService";
import { useEffect, useState } from "react";
import {
  preferCachedResponse,
  RECENT_RESULTS_MS,
  requireNetworkResponse,
  shouldFetchLatest,
} from "sharedHelpers/httpCache";
import { log } from "sharedHelpers/logger";
import {
  createRequestTimeoutSignal, handleRetryDelay, reactQueryRetry,
} from "sharedHelpers/logging";

const LOGGED_IN_UNKNOWN = null;

export type AuthenticatedQueryOptions<Response> = Omit<
  UseQueryOptions<Response>,
  "queryKey" | "queryFn" | "enabled" | "retry"
> & {
  allowAnonymousJWT?: boolean;
  enabled?: boolean;
  retry?: boolean;
  refetchInterval?: number | false;
  // Keep the query disabled until the user is actually signed in (a token
  // exists). Without this a query can fire with a null JWT — e.g. a stale
  // Realm currentUser but no stored credentials — and 401 on every poll.
  requireLoggedIn?: boolean;
  // False to go to the network first, as for a query whose results are
  // written somewhere a cached copy shouldn't be
  cacheFirst?: boolean;
}

const logger = log.extend( "useAuthenticatedQuery" );

// The cache key useAuthenticatedQuery actually uses. Exported so code that writes to the cache
// directly (e.g. queryClient.setQueryData) can match it
export const authenticatedQueryKey = (
  queryKey: QueryKey,
  { allowAnonymousJWT, userLoggedIn }: {
    allowAnonymousJWT?: boolean;
    userLoggedIn: boolean | null;
  },
): QueryKey => [...queryKey, allowAnonymousJWT, userLoggedIn];

export type QueryFunction<Response>
  = ( options: { api_token: string | null; signal: AbortSignal } ) => Promise<Response>;

// Should work like React Query's useQuery except it calls the queryFunction
// with an object that includes the JWT.
//
// Results in the HTTP cache come from there, as they do when the network
// fails, and are shown at once. Unless they were fetched in the last
// RECENT_RESULTS_MS, the latest are fetched in the background and replace
// them when they arrive. A refetch (say pulling to refresh) of results
// already shown goes to the network.
const useAuthenticatedQuery = <Response>(
  queryKey: QueryKey,
  queryFunction: QueryFunction<Response>,
  queryOptions: AuthenticatedQueryOptions<Response> = {},
) => {
  const queryClient = useQueryClient( );
  const [userLoggedIn, setUserLoggedIn] = useState<boolean | null>( LOGGED_IN_UNKNOWN );
  const { cacheFirst = true, ...useQueryOptions } = queryOptions;

  useEffect( ( ) => {
    const checkAuth = async ( ) => {
      try {
        const result = await isLoggedIn( );
        setUserLoggedIn( result );
      } catch ( error ) {
        console.warn( "Auth check failed:", error );
        setUserLoggedIn( false );
      }
    };

    checkAuth( );
  }, [] );

  // The results will probably be different depending on whether the user is
  // signed in or we wouldn't be using useAuthenticatedQuery in the first
  // place, so we need to redo this request if the auth state changed
  const authQueryKey = authenticatedQueryKey( queryKey, {
    allowAnonymousJWT: queryOptions.allowAnonymousJWT,
    userLoggedIn,
  } );

  return useQuery( {
    // cacheFirst only changes where the same results come from
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: authQueryKey,
    queryFn: async ( { queryKey: key } ) => {
      const fetchResponse = async ( markSignal?: ( signal: AbortSignal ) => AbortSignal ) => {
        // Note, getJWT() takes care of fetching a new token if the existing
        // one is expired. We *could* store the token in state with useState if
        // fetching from RNSInfo becomes a performance issue
        const apiToken = await getJWT( queryOptions.allowAnonymousJWT );
        const { signal, clear } = createRequestTimeoutSignal( );
        markSignal?.( signal );
        try {
          const response = await queryFunction( { api_token: apiToken, signal } );
          return { response, fetchLatest: shouldFetchLatest( signal ) };
        } finally {
          clear( );
        }
      };
      // Results already shown stay while React Query fetches them again, as
      // when pulling to refresh, from the network
      const { response, fetchLatest } = await fetchResponse(
        cacheFirst && queryClient.getQueryData( key ) === undefined
          ? preferCachedResponse
          : undefined,
      );
      if ( fetchLatest && onlineManager.isOnline( ) ) {
        fetchResponse( requireNetworkResponse )
          .then( latest => queryClient.setQueryData( key, latest.response ) )
          .catch( error => {
            logger.warn( "Couldn't fetch the latest results, showing cached ones", error );
          } );
      }
      return response;
    },
    // Results fetched in the last RECENT_RESULTS_MS aren't fetched again
    // when shown again
    ...( cacheFirst && { staleTime: RECENT_RESULTS_MS } ),
    ...useQueryOptions,
    retry: queryOptions.retry !== false
      ? ( failureCount, error ) => reactQueryRetry( failureCount, error, {
        queryKey,
      } )
      : false,
    retryDelay: ( failureCount, error ) => handleRetryDelay( failureCount, error ),
    // Authenticated queries should not run until we know whether or not the
    // user is signed in; when requireLoggedIn is set, also wait until they are
    // actually signed in so we never call an authenticated endpoint with a
    // null token.
    enabled: userLoggedIn !== LOGGED_IN_UNKNOWN
      && ( !queryOptions.requireLoggedIn || userLoggedIn === true )
      && queryOptions.enabled,
  } );
};

export default useAuthenticatedQuery;
