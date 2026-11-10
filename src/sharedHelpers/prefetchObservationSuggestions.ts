import type { QueryClient } from "@tanstack/react-query";
import scoreImage from "api/computerVision";
import { getJWT, isLoggedIn } from "components/LoginSignUp/AuthenticationService";
import flattenUploadParams from "components/Suggestions/helpers/flattenUploadParams";
import i18n from "i18next";
import type Realm from "realm";
import ObservationPhoto from "realmModels/ObservationPhoto";
import type { RealmObservationPojo } from "realmModels/types";
import User from "realmModels/User";
import { createRequestTimeoutSignal } from "sharedHelpers/logging";
import {
  getCachedSuggestions,
  offlineSuggestionsCacheKey,
  onlineSuggestionsCacheKey,
  setCachedSuggestions,
} from "sharedHelpers/suggestionsCache";
import { onlineSuggestionsQueryKey } from "sharedHelpers/suggestionsQueryKey";
import type { OfflineSuggestionsResponse } from "sharedHooks/useSuggestions/useOfflineSuggestions";
import { predictOffline } from "sharedHooks/useSuggestions/useOfflineSuggestions";
import type {
  OnlineSuggestionsQueryResponse,
} from "sharedHooks/useSuggestions/useOnlineSuggestions";

interface OnlineSuggestionsApiResponse {
  results: OnlineSuggestionsQueryResponse["results"];
  common_ancestor?: {
    score: number;
    taxon: OnlineSuggestionsQueryResponse["results"][0]["taxon"];
  };
}

// Mirror the Suggestions screen: the evidence location is only used when the
// observation actually has one, and that choice is baked into both cache keys.
const scoreParamsForObservation = ( observation: RealmObservationPojo ) => {
  const shouldUseEvidenceLocation = !!observation.latitude;
  return {
    photoUri: ObservationPhoto.mapObsPhotoUris( observation )[0],
    shouldUseEvidenceLocation,
    latitude: shouldUseEvidenceLocation && observation.latitude != null
      ? observation.latitude
      : undefined,
    longitude: shouldUseEvidenceLocation && observation.longitude != null
      ? observation.longitude
      : undefined,
  };
};

// Offline model: run on-device inference once and persist it, or hand back
// what an earlier run persisted. Failures are swallowed so a bad photo doesn't
// stop the caller.
export const prefetchOfflineSuggestions = async (
  observation: RealmObservationPojo,
  realm: Realm,
): Promise<OfflineSuggestionsResponse | null> => {
  const { photoUri, latitude, longitude } = scoreParamsForObservation( observation );
  if ( !photoUri ) {
    return null;
  }
  const offlineKey = offlineSuggestionsCacheKey( photoUri, latitude, longitude );
  const cached = getCachedSuggestions<OfflineSuggestionsResponse>( offlineKey );
  if ( cached ) {
    return cached;
  }
  const offlineSuggestions = await predictOffline( {
    latitude,
    longitude,
    photoUri,
    realm,
  } ).catch( ( ) => null );
  if ( offlineSuggestions ) {
    setCachedSuggestions( offlineKey, offlineSuggestions );
  }
  return offlineSuggestions;
};

// Whether the online model's result for this observation is already on disk,
// under the same key the Suggestions screen reads, so opening it would show
// online suggestions without waiting on the network.
export const hasCachedOnlineSuggestions = (
  observation: RealmObservationPojo,
  realm: Realm,
): boolean => {
  const { photoUri, shouldUseEvidenceLocation } = scoreParamsForObservation( observation );
  if ( !photoUri ) {
    return false;
  }
  const queryKey = onlineSuggestionsQueryKey( photoUri, shouldUseEvidenceLocation );
  const onlineKey = onlineSuggestionsCacheKey(
    queryKey,
    !!User.currentUser( realm ),
    i18n?.language ?? "en",
  );
  return !!getCachedSuggestions( onlineKey );
};

const shimApiResponseForCommonAncestor = (
  apiSuggestions: OnlineSuggestionsApiResponse,
): OnlineSuggestionsQueryResponse => {
  const shimmedCommonAncestor = apiSuggestions.common_ancestor
    ? {
      ...apiSuggestions.common_ancestor,
      combined_score: apiSuggestions.common_ancestor.score,
      taxon: apiSuggestions.common_ancestor.taxon,
    }
    : undefined;
  return {
    results: apiSuggestions.results,
    common_ancestor: shimmedCommonAncestor,
  };
};

// Online model: warm the persistent cache (survives restarts) as well as the
// in-memory React Query cache (instant for a same-session visit).
const prefetchOnlineSuggestions = async (
  queryClient: QueryClient,
  observation: RealmObservationPojo,
  realm: Realm,
): Promise<void> => {
  const {
    photoUri,
    shouldUseEvidenceLocation,
    latitude,
    longitude,
  } = scoreParamsForObservation( observation );
  if ( !photoUri ) {
    return;
  }

  const locale = i18n?.language ?? "en";
  const hasCurrentUser = !!User.currentUser( realm );
  const queryKey = onlineSuggestionsQueryKey( photoUri, shouldUseEvidenceLocation );

  const onlineKey = onlineSuggestionsCacheKey( queryKey, hasCurrentUser, locale );
  if ( getCachedSuggestions( onlineKey ) ) {
    return;
  }

  const scoreImageParams = await flattenUploadParams( photoUri );
  if ( latitude != null ) {
    scoreImageParams.lat = latitude;
    scoreImageParams.lng = longitude;
  }
  const userLoggedIn = await isLoggedIn( );
  const authQueryKey = [...queryKey, true, userLoggedIn];

  await queryClient.prefetchQuery( {
    // The key deliberately mirrors useOnlineSuggestions so the prefetch shares
    // its cache entry; the extra queryFn values are inputs, not cache identity.
    // eslint-disable-next-line @tanstack/query/exhaustive-deps
    queryKey: authQueryKey,
    queryFn: async ( ) => {
      const apiToken = await getJWT( true );
      // Without a deadline a stalled prefetch holds its connection forever,
      // and the request the user is actually waiting on queues behind it.
      const { signal, clear } = createRequestTimeoutSignal( );
      let suggestionsResponse: OnlineSuggestionsApiResponse;
      try {
        suggestionsResponse = await scoreImage(
          {
            ...scoreImageParams,
            ...( !hasCurrentUser && { locale } ),
          },
          { api_token: apiToken, signal },
          { source: "prefetch" },
        ) as OnlineSuggestionsApiResponse;
      } finally {
        clear( );
      }

      const shimmed = shimApiResponseForCommonAncestor( suggestionsResponse );
      setCachedSuggestions( onlineKey, shimmed );
      return shimmed;
    },
    // Nothing is on screen waiting for this, and a retry would only take a
    // slot from the observation the user is looking at.
    retry: false,
  } );
};

// Score the first photo of an observation ahead of time with both the offline
// (on-device) and online (API) models, persisting each result under the exact
// cache key the Suggestions screen reads from. Because both hooks check that
// cache before doing any work, a prefetched photo is never scored a second
// time.
//
// The two models run concurrently: on-device inference is CPU bound and the
// API request is network bound, so making the online request wait for the
// offline one only delayed the result the user waits longest for.
const prefetchObservationSuggestions = async (
  queryClient: QueryClient,
  observation: RealmObservationPojo,
  realm: Realm,
): Promise<void> => {
  await Promise.all( [
    prefetchOfflineSuggestions( observation, realm ).catch( ( ) => null ),
    prefetchOnlineSuggestions( queryClient, observation, realm ),
  ] );
};

// Runs tasks with at most `limit` in flight, starting queued ones in order as
// slots free. Shared by every bulk prefetch, so imports that arrive while an
// earlier one is still scoring join the same queue instead of adding their own
// requests on top.
const createLimiter = ( limit: number ) => {
  let active = 0;
  const queue: ( ( ) => void )[] = [];
  return async <T>( task: ( ) => Promise<T> ): Promise<T> => {
    if ( active >= limit ) {
      await new Promise<void>( resolve => { queue.push( resolve ); } );
    }
    active += 1;
    try {
      return await task( );
    } finally {
      active -= 1;
      queue.shift( )?.( );
    }
  };
};

// On-device inference is CPU bound, so it runs one at a time; the online
// requests are network bound and run three at a time.
const offlineLimiter = createLimiter( 1 );
const onlineLimiter = createLimiter( 3 );

export interface PrefetchTimings {
  count: number;
  offlineMs: number;
  onlineMs: number;
}

const timed = async ( task: ( ) => Promise<unknown> ): Promise<number> => {
  const startedAt = Date.now( );
  await task( ).catch( ( ) => undefined );
  return Date.now( ) - startedAt;
};

// Prefetch suggestions for several observations through the shared queues
// above, so importing a large batch of grouped photos doesn't fire dozens of
// concurrent CV requests and on-device inferences at once. Never rejects;
// resolves with the time spent in each model, summed over the observations.
export const prefetchSuggestionsForObservations = async (
  queryClient: QueryClient,
  observations: RealmObservationPojo[],
  realm: Realm,
): Promise<PrefetchTimings> => {
  const timings = await Promise.all( observations.map( async observation => {
    const [offlineMs, onlineMs] = await Promise.all( [
      offlineLimiter( ( ) => timed(
        ( ) => prefetchOfflineSuggestions( observation, realm ),
      ) ),
      onlineLimiter( ( ) => timed(
        ( ) => prefetchOnlineSuggestions( queryClient, observation, realm ),
      ) ),
    ] );
    return { offlineMs, onlineMs };
  } ) );
  return timings.reduce( ( sum, t ) => ( {
    count: sum.count + 1,
    offlineMs: sum.offlineMs + t.offlineMs,
    onlineMs: sum.onlineMs + t.onlineMs,
  } ), { count: 0, offlineMs: 0, onlineMs: 0 } );
};

export default prefetchObservationSuggestions;
