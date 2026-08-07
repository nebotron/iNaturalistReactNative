import type { QueryClient } from "@tanstack/react-query";
import scoreImage from "api/computerVision";
import { getJWT, isLoggedIn } from "components/LoginSignUp/AuthenticationService";
import flattenUploadParams from "components/Suggestions/helpers/flattenUploadParams";
import i18n from "i18next";
import type Realm from "realm";
import ObservationPhoto from "realmModels/ObservationPhoto";
import type { RealmObservationPojo } from "realmModels/types";
import User from "realmModels/User";
import {
  getCachedSuggestions,
  offlineSuggestionsCacheKey,
  onlineSuggestionsCacheKey,
  setCachedSuggestions,
} from "sharedHelpers/suggestionsCache";
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

// Score the first photo of an observation ahead of time with both the offline
// (on-device) and online (API) models, persisting each result under the exact
// cache key the Suggestions screen reads from. Because both hooks check that
// cache before doing any work, a prefetched photo is never scored a second
// time.
const prefetchObservationSuggestions = async (
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
  const queryKey = ["scoreImage", photoUri, { shouldUseEvidenceLocation }];

  await prefetchOfflineSuggestions( observation, realm );

  // Online model: warm the persistent cache (survives restarts) as well as the
  // in-memory React Query cache (instant for a same-session visit).
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
      const suggestionsResponse = await scoreImage(
        {
          ...scoreImageParams,
          ...( !hasCurrentUser && { locale } ),
        },
        { api_token: apiToken },
      ) as OnlineSuggestionsApiResponse;

      const shimmed = shimApiResponseForCommonAncestor( suggestionsResponse );
      setCachedSuggestions( onlineKey, shimmed );
      return shimmed;
    },
  } );
};

// Prefetch suggestions for several observations one at a time, so importing a
// large batch of grouped photos doesn't fire dozens of concurrent CV requests
// and on-device inferences at once. Fire-and-forget: individual failures are
// logged by the caller, not thrown.
export const prefetchSuggestionsForObservations = async (
  queryClient: QueryClient,
  observations: RealmObservationPojo[],
  realm: Realm,
): Promise<void> => {
  for ( const observation of observations ) {
    // eslint-disable-next-line no-await-in-loop
    await prefetchObservationSuggestions( queryClient, observation, realm )
      .catch( ( ) => undefined );
  }
};

export default prefetchObservationSuggestions;
