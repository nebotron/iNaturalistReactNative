import { useRoute } from "@react-navigation/native";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import i18n from "i18next";
import { useCallback, useEffect, useRef } from "react";
import {
  createRequestTimeoutSignal, handleRetryDelay, reactQueryRetry,
} from "sharedHelpers/logging";
import {
  PERSISTED_QUERY_META,
  PERSISTED_QUERY_TTL_MS,
  readPersistedQuery,
  readPersistedQueryUpdatedAt,
} from "sharedHelpers/persistedQueries";
import { useCurrentUser } from "sharedHooks";

// Should work like React Query's useInfiniteQuery with our custom reactQueryRetry
// and authentication.
//
// With `persist: true` the results are saved to disk and shown again after a
// restart, and are only fetched again after PERSISTED_QUERY_TTL_MS or when
// refreshFirstPage is called.
interface AuthenticatedInfiniteQueryOptions {
  allowAnonymousJWT?: boolean;
  persist?: boolean;
  [option: string]: unknown;
}

const useAuthenticatedInfiniteQuery = (
  queryKey: string[],
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  queryFunction: Function,
  queryOptions: AuthenticatedInfiniteQueryOptions = {},
): object => {
  const route = useRoute( );
  const currentUser = useCurrentUser( );
  const queryClient = useQueryClient( );
  const { persist, ...infiniteQueryOptions } = queryOptions;

  // Use locale in case there is no user session
  const locale = i18n?.language ?? "en";

  // A persisted query's key has to survive a restart, so it holds only what
  // changes the results rather than the whole user, whose counts change all
  // the time
  const userKey = persist
    ? {
      id: currentUser?.id ?? null,
      locale: currentUser?.locale ?? locale,
      prefersCommonNames: currentUser?.prefers_common_names,
      prefersCommunityTaxa: currentUser?.prefers_community_taxa,
      prefersScientificNameFirst: currentUser?.prefers_scientific_name_first,
    }
    : currentUser;
  const fullQueryKey = [...queryKey, queryOptions.allowAnonymousJWT, userKey];

  const queryFn = async ( params: Record<string, unknown> ) => {
    if ( !currentUser ) {
      params.locale = locale;
    }
    // logger.info( queryKey, "queryKey in useAuthenticatedInfiniteQuery" );
    // Note, getJWT() takes care of fetching a new token if the existing
    // one is expired. We *could* store the token in state with useState if
    // fetching from RNSInfo becomes a performance issue
    const apiToken = await getJWT( queryOptions.allowAnonymousJWT );
    const { signal, clear } = createRequestTimeoutSignal( );
    const options = {
      api_token: apiToken,
      signal,
    };
    try {
      return await queryFunction( params, options );
    } finally {
      clear( );
    }
  };

  // Read only when React Query first creates the query, so once per key
  const persistOptions = persist
    ? {
      meta: PERSISTED_QUERY_META,
      staleTime: PERSISTED_QUERY_TTL_MS,
      gcTime: PERSISTED_QUERY_TTL_MS,
      initialData: ( ) => readPersistedQuery( fullQueryKey ),
      initialDataUpdatedAt: ( ) => readPersistedQueryUpdatedAt( fullQueryKey ),
    }
    : {};

  const query = useInfiniteQuery( {
    queryKey: fullQueryKey,
    queryFn,
    retry: ( failureCount, error ) => reactQueryRetry( failureCount, error, {
      queryKey,
      routeName: route?.name,
      routeParams: route?.params,
    } ),
    retryDelay: ( failureCount, error ) => handleRetryDelay( failureCount, error ),
    ...persistOptions,
    ...infiniteQueryOptions,
  } );

  // Fetches the first page again and, only if that works, replaces every page
  // with it. The results already shown stay while it runs and if it fails, in
  // which case this throws. Reads the latest key and query function from a
  // ref, so it keeps one identity.
  const latestRef = useRef( { queryFn, fullQueryKey } );
  useEffect( ( ) => {
    latestRef.current = { queryFn, fullQueryKey };
  } );
  const refreshFirstPage = useCallback( async ( ) => {
    const { queryFn: fetchPage, fullQueryKey: key } = latestRef.current;
    const firstPage = await fetchPage( { queryKey: key, pageParam: undefined } );
    if ( firstPage == null ) {
      throw new Error( "No results from refreshing the first page" );
    }
    // A next page still loading would otherwise add itself to the old pages
    await queryClient.cancelQueries( { queryKey: key, exact: true } );
    queryClient.setQueryData( key, {
      pages: [firstPage],
      pageParams: [undefined],
    } );
  }, [queryClient] );

  // Added rather than spread in, so React Query still only re-renders for the
  // fields a caller reads
  return Object.assign( query, { refreshFirstPage } );
};

export default useAuthenticatedInfiniteQuery;
