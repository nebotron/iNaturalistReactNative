import { useRoute } from "@react-navigation/native";
import {
  hashKey, onlineManager, useInfiniteQuery, useQueryClient,
} from "@tanstack/react-query";
import { getJWT } from "components/LoginSignUp/AuthenticationService";
import i18n from "i18next";
import {
  useCallback, useEffect, useRef, useState, useSyncExternalStore,
} from "react";
import type { UserPojo } from "realmModels/User";
import {
  preferCachedResponse,
  RECENT_RESULTS_MS,
  requireNetworkResponse,
  shouldFetchLatest,
  wasServedFromCache,
} from "sharedHelpers/httpCache";
import { log } from "sharedHelpers/logger";
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
// restart.
//
// A page in the HTTP cache comes from there rather than the network, unless
// `cacheFirst` is false. refreshFirstPage
// always goes to the network.
//
// Whenever cached results are shown (saved to disk, from the HTTP cache, or
// kept in memory since an earlier visit) that were fetched more than
// RECENT_RESULTS_MS ago, the latest are fetched in the background and replace
// them when they arrive. Pulling to refresh (refreshFirstPage) always goes to
// the network.
//
// With `noCache` nothing cached is ever shown: results come only from the
// network, and are dropped from memory once nothing shows them.
//
// With `abortWhenUnused` a page still loading when nothing shows its query any
// more (say a newer search replaced it) is aborted, rather than finishing in
// the background on a connection the new search needs.
//
// A failed attempt to replace cached results with the latest is retried with
// backoff while they're shown, and reported as `refreshFailed`.
interface AuthenticatedInfiniteQueryOptions {
  allowAnonymousJWT?: boolean;
  persist?: boolean;
  cacheFirst?: boolean;
  noCache?: boolean;
  abortWhenUnused?: boolean;
  [option: string]: unknown;
}

const logger = log.extend( "useAuthenticatedInfiniteQuery" );

// Backoff for fetching the latest results again after that failed
const RETRY_REVALIDATION_MIN_MS = 5 * 1000;
const RETRY_REVALIDATION_MAX_MS = 2 * 60 * 1000;

// Hashes of the queries showing cached results, waiting to be fetched again
// from the network, and of those being fetched again
const needsRevalidation = new Set<string>( );
const revalidating = new Set<string>( );
// Hashes of the queries fetched again this way, whose later pages then come
// from the network too, rather than from the cache one after another, each
// starting another refetch
const revalidated = new Set<string>( );

interface InfinitePages {
  pages: unknown[];
  pageParams: unknown[];
}

const subscribeToOnline = ( onChange: ( ) => void ) => onlineManager.subscribe( onChange );
const getIsOnline = ( ) => onlineManager.isOnline( );

// A persisted query's key has to survive a restart, so it holds only what
// changes the results rather than the whole user, whose counts change all the
// time. Exported for code that fills the same query outside the hook.
export const persistedQueryUserKey = ( currentUser: UserPojo | null ) => ( {
  id: currentUser?.id ?? null,
  locale: currentUser?.locale ?? i18n?.language ?? "en",
  prefersCommonNames: currentUser?.prefers_common_names,
  prefersCommunityTaxa: currentUser?.prefers_community_taxa,
  prefersScientificNameFirst: currentUser?.prefers_scientific_name_first,
} );

const useAuthenticatedInfiniteQuery = (
  queryKey: string[],
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  queryFunction: Function,
  queryOptions: AuthenticatedInfiniteQueryOptions = {},
) => {
  const route = useRoute( );
  const currentUser = useCurrentUser( );
  const queryClient = useQueryClient( );
  const {
    noCache = false,
    persist: persistOption,
    cacheFirst: cacheFirstOption,
    abortWhenUnused = false,
    ...infiniteQueryOptions
  } = queryOptions;
  const persist = !noCache && !!persistOption;
  const cacheFirst = !noCache && ( cacheFirstOption ?? true );
  const enabled = infiniteQueryOptions.enabled !== false;
  const isOnline = useSyncExternalStore( subscribeToOnline, getIsOnline );

  // Use locale in case there is no user session
  const locale = i18n?.language ?? "en";

  const userKey = persist
    ? persistedQueryUserKey( currentUser )
    : currentUser;
  const fullQueryKey = [...queryKey, queryOptions.allowAnonymousJWT, userKey];
  const queryHash = hashKey( fullQueryKey );

  // A page, and whether it came from the HTTP cache rather than the network
  const fetchPage = async (
    params: Record<string, unknown>,
    { fromNetwork = false }: { fromNetwork?: boolean } = {},
  ) => {
    // React Query's, aborted once nothing shows the query
    const querySignal = abortWhenUnused
      ? params?.signal as AbortSignal | undefined
      : undefined;
    if ( !currentUser ) {
      params.locale = locale;
    }
    // logger.info( queryKey, "queryKey in useAuthenticatedInfiniteQuery" );
    // Note, getJWT() takes care of fetching a new token if the existing
    // one is expired. We *could* store the token in state with useState if
    // fetching from RNSInfo becomes a performance issue
    const apiToken = await getJWT( queryOptions.allowAnonymousJWT );
    const { signal: timeoutSignal, clear } = createRequestTimeoutSignal( querySignal );
    const signal = cacheFirst && !fromNetwork
      ? preferCachedResponse( timeoutSignal )
      : timeoutSignal;
    if ( noCache ) requireNetworkResponse( signal );
    try {
      const page = await queryFunction( params, { api_token: apiToken, signal } );
      return {
        page,
        fromCache: wasServedFromCache( signal ),
        fetchLatest: shouldFetchLatest( signal ),
      };
    } finally {
      clear( );
    }
  };

  const queryFn = async ( params: Record<string, unknown> ) => {
    const hash = Array.isArray( params?.queryKey )
      ? hashKey( params.queryKey )
      : queryHash;
    const { page, fetchLatest } = await fetchPage( params, {
      fromNetwork: revalidated.has( hash ),
    } );
    if ( fetchLatest ) needsRevalidation.add( hash );
    return page;
  };

  // Read only when React Query first creates the query, so once per key
  const persistOptions = persist
    ? {
      meta: PERSISTED_QUERY_META,
      staleTime: PERSISTED_QUERY_TTL_MS,
      gcTime: PERSISTED_QUERY_TTL_MS,
      initialData: ( ) => {
        const saved = readPersistedQuery( fullQueryKey );
        const savedAt = readPersistedQueryUpdatedAt( fullQueryKey ) ?? 0;
        if ( saved !== undefined && Date.now( ) - savedAt >= RECENT_RESULTS_MS ) {
          needsRevalidation.add( queryHash );
        }
        return saved;
      },
      initialDataUpdatedAt: ( ) => readPersistedQueryUpdatedAt( fullQueryKey ),
    }
    : {};
  // Results fetched in the last RECENT_RESULTS_MS aren't fetched again when
  // shown again
  const cacheFirstOptions = cacheFirst && !persist
    ? { staleTime: RECENT_RESULTS_MS }
    : {};
  const noCacheOptions = noCache
    ? { staleTime: 0, gcTime: 0, refetchOnMount: "always" as const }
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
    ...cacheFirstOptions,
    ...infiniteQueryOptions,
    ...noCacheOptions,
  } );

  // Fetches the first page again and, only if that works, replaces every page
  // with it. The results already shown stay while it runs and if it fails, in
  // which case this throws. Reads the latest key and query function from a
  // ref, so it keeps one identity.
  const { getNextPageParam } = infiniteQueryOptions as {
    getNextPageParam?: ( ...args: unknown[] ) => unknown;
  };
  const latestRef = useRef( { fetchPage, fullQueryKey, getNextPageParam } );
  useEffect( ( ) => {
    latestRef.current = { fetchPage, fullQueryKey, getNextPageParam };
  } );
  const refreshFirstPage = useCallback( async ( ) => {
    const { fetchPage: fetchFromNetwork, fullQueryKey: key } = latestRef.current;
    const { page: firstPage, fromCache } = await fetchFromNetwork(
      { queryKey: key, pageParam: undefined },
      { fromNetwork: true },
    );
    if ( firstPage == null || fromCache ) {
      throw new Error( "No results from refreshing the first page" );
    }
    // A next page still loading would otherwise add itself to the old pages
    await queryClient.cancelQueries( { queryKey: key, exact: true } );
    queryClient.setQueryData( key, {
      pages: [firstPage],
      pageParams: [undefined],
    } );
  }, [queryClient] );

  // Fetches every page shown again from the network and, only if they all
  // arrive, puts them in place of the cached ones. Pages loaded meanwhile by
  // scrolling stay after them.
  const revalidate = useCallback( async ( ) => {
    const {
      fetchPage: fetchFromNetwork,
      fullQueryKey: key,
      getNextPageParam: nextPageParam,
    } = latestRef.current;
    const shown = queryClient.getQueryData<InfinitePages>( key );
    if ( !shown?.pages?.length ) return;
    const pages: unknown[] = [];
    const pageParams: unknown[] = [];
    let pageParam = shown.pageParams[0];
    for ( let i = 0; i < shown.pages.length; i += 1 ) {
      // One page after another, as each page's param comes from the last
      // eslint-disable-next-line no-await-in-loop
      const { page, fromCache } = await fetchFromNetwork(
        { queryKey: key, pageParam },
        { fromNetwork: true },
      );
      if ( page == null || fromCache ) {
        throw new Error( "Couldn't fetch the latest results" );
      }
      pages.push( page );
      pageParams.push( pageParam );
      if ( i + 1 < shown.pages.length ) {
        pageParam = nextPageParam?.( page, pages, pageParam, pageParams );
        if ( pageParam == null ) break;
      }
    }
    const current = queryClient.getQueryData<InfinitePages>( key );
    // Refreshed some other way meanwhile
    if ( !current || current.pages[0] !== shown.pages[0] ) return;
    const loadedSince = pages.length === shown.pages.length
      ? current.pages.length - shown.pages.length
      : 0;
    // A next page still loading would otherwise add itself to the old pages
    await queryClient.cancelQueries( { queryKey: key, exact: true } );
    queryClient.setQueryData( key, {
      pages: [...pages, ...current.pages.slice( shown.pages.length ).slice( 0, loadedSince )],
      pageParams: [
        ...pageParams,
        ...current.pageParams.slice( shown.pageParams.length ).slice( 0, loadedSince ),
      ],
    } );
  }, [queryClient] );

  // Results React Query keeps in memory are shown again without being fetched
  // when a persisted query's screen comes back, as its staleTime is long
  useEffect( ( ) => {
    if ( !persist || !enabled ) return;
    const { dataUpdatedAt, data } = queryClient.getQueryState( fullQueryKey ) ?? {};
    if ( data !== undefined && Date.now( ) - ( dataUpdatedAt ?? 0 ) >= RECENT_RESULTS_MS ) {
      needsRevalidation.add( queryHash );
    }
  // Only when the query is first shown
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryHash, enabled, persist] );

  const { isFetching, dataUpdatedAt } = query;
  // The query whose latest attempt to replace cached results failed, and the
  // backoff before the next. Bumping retryCount runs the effect below again.
  const [refreshFailedHash, setRefreshFailedHash] = useState<string | null>( null );
  const refreshFailed = refreshFailedHash === queryHash;
  const [retryCount, setRetryCount] = useState( 0 );
  const retryDelayRef = useRef( RETRY_REVALIDATION_MIN_MS );
  useEffect( ( ) => {
    if ( !refreshFailed || !enabled || !isOnline ) return ( ) => undefined;
    const timer = setTimeout( ( ) => setRetryCount( count => count + 1 ), retryDelayRef.current );
    retryDelayRef.current = Math.min( retryDelayRef.current * 2, RETRY_REVALIDATION_MAX_MS );
    return ( ) => clearTimeout( timer );
  }, [refreshFailed, enabled, isOnline, retryCount] );
  useEffect( ( ) => {
    if (
      noCache
      || !enabled
      || !isOnline
      || isFetching
      || !needsRevalidation.has( queryHash )
      || revalidating.has( queryHash )
    ) return;
    needsRevalidation.delete( queryHash );
    revalidating.add( queryHash );
    revalidate( )
      .then( ( ) => {
        revalidated.add( queryHash );
        retryDelayRef.current = RETRY_REVALIDATION_MIN_MS;
        setRefreshFailedHash( failedHash => ( failedHash === queryHash
          ? null
          : failedHash ) );
      } )
      .catch( error => {
        // Tried again with backoff, once back online, or when more results load
        needsRevalidation.add( queryHash );
        setRefreshFailedHash( failedHash => {
          // Another search's failures don't add to this one's backoff
          if ( failedHash !== queryHash ) retryDelayRef.current = RETRY_REVALIDATION_MIN_MS;
          return queryHash;
        } );
        logger.warn( "Couldn't fetch the latest results, showing cached ones", error );
      } )
      .finally( ( ) => revalidating.delete( queryHash ) );
  }, [
    noCache,
    enabled,
    isOnline,
    isFetching,
    dataUpdatedAt,
    queryHash,
    revalidate,
    retryCount,
  ] );

  // Added rather than spread in, so React Query still only re-renders for the
  // fields a caller reads
  return Object.assign( query, { refreshFirstPage, refreshFailed } );
};

export default useAuthenticatedInfiniteQuery;
