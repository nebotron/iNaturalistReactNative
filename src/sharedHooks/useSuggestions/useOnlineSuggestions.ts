import scoreImage from "api/computerVision";
import i18n from "i18next";
import { RealmContext } from "providers/contexts";
import {
  useEffect, useMemo, useRef,
} from "react";
import { UpdateMode } from "realm";
import Taxon from "realmModels/Taxon";
import safeRealmWrite from "sharedHelpers/safeRealmWrite";
import {
  getCachedSuggestions,
  onlineSuggestionsCacheKey,
  setCachedSuggestions,
} from "sharedHelpers/suggestionsCache";
import {
  useAuthenticatedQuery,
  useCurrentUser,
} from "sharedHooks";
import useStore from "stores/useStore";

import { startOfflineExperimentInBackground } from "./suggestionComparisonExperiment";
import type { ScoreImageParams, UseSuggestionsOnlineSuggestion } from "./types";
import { predictOffline } from "./useOfflineSuggestions";

const { useRealm } = RealmContext;

interface OnlineSuggestionOptions {
  onFetchError: ( options: { isOnline: boolean } ) => void;
  onFetched: ( options: { isOnline: boolean } ) => void;
  scoreImageParams?: ScoreImageParams;
  queryKey: string[];
  shouldFetchOnlineSuggestions: boolean;
}

interface UseOnlineSuggestionsResponse {
  dataUpdatedAt: number;
  onlineSuggestions?: {
    results: UseSuggestionsOnlineSuggestion[];
    common_ancestor?: UseSuggestionsOnlineSuggestion;
  };
  error: Error | null;
  refetch: () => void;
}

export interface OnlineSuggestionsApiResponse {
  results: UseSuggestionsOnlineSuggestion[];
  common_ancestor?: Omit<UseSuggestionsOnlineSuggestion, "combined_score">;
}

export interface OnlineSuggestionsQueryResponse {
  results: UseSuggestionsOnlineSuggestion[];
  common_ancestor?: UseSuggestionsOnlineSuggestion;
}

export const shimApiResponseForCommonAncestor
  = ( apiSuggestions: OnlineSuggestionsApiResponse ): OnlineSuggestionsQueryResponse => {
    // TODO MOB-1081: maybe we can catch this shim earlier?
    // general context: https://github.com/inaturalist/iNaturalistReactNative/blob/505980d3359876a0af383f2ffcc481921f0eb778/src/components/Match/calculateConfidence.ts#L10-L12
    // online suggs have `score` but _redact_ `combined_score` for commonAncestor https://github.com/inaturalist/iNaturalistAPI/blob/main/lib/controllers/v1/computervision_controller.js#L389
    // the offline suggs have `combined_score` but don't have `score`
    // the codebase tends assumes `combined_score` for whenever that matters
    // the following catches when we're in a "fake" onlineSugg and shims "score" in
    const shimmedCommonAncestor = apiSuggestions.common_ancestor
      ? {
        ...apiSuggestions.common_ancestor,
        combined_score: apiSuggestions.common_ancestor.score,
      }
      : undefined;
    return {
      results: apiSuggestions.results,
      common_ancestor: shimmedCommonAncestor,
    };
  };

const useOnlineSuggestions = (
  options: OnlineSuggestionOptions,
): UseOnlineSuggestionsResponse => {
  const realm = useRealm( );
  const {
    onFetchError,
    onFetched,
    scoreImageParams,
    queryKey,
    shouldFetchOnlineSuggestions,
  } = options;

  const currentUser = useCurrentUser();
  // Use locale in case there is no user session
  const locale = i18n?.language ?? "en";

  const getCurrentObservation = useStore( state => state.getCurrentObservation );
  // Counts requests for the current query so retries are labeled in the log
  const attempts = useRef( { key: "", count: 0 } );

  // Read already-scored results synchronously so they show on the first render
  // instead of after the image is resized and the query runs, which would
  // briefly flash the offline suggestions
  const syncCacheKey = onlineSuggestionsCacheKey( queryKey, !!currentUser, locale );
  const cachedOnlineSuggestions = useMemo( ( ) => ( queryKey.length > 0
    ? getCachedSuggestions<OnlineSuggestionsQueryResponse>( syncCacheKey )
    : undefined ), [queryKey.length, syncCacheKey] );

  // TODO if this is a remote observation with an `id` param, use
  // scoreObservation instead so we don't have to spend time resizing and
  // uploading images
  const {
    data: fetchedOnlineSuggestions,
    dataUpdatedAt,
    refetch,
    error,
  } = useAuthenticatedQuery<OnlineSuggestionsQueryResponse>(
    queryKey,
    async optsWithAuth => {
      // Calling the API is expensive (network + server-side scoring), so
      // avoid re-fetching for a query/auth state we've already resolved,
      // even across app restarts.
      const cacheKey = onlineSuggestionsCacheKey( queryKey, !!currentUser, locale );
      const cachedSuggestions = getCachedSuggestions<OnlineSuggestionsQueryResponse>( cacheKey );
      if ( cachedSuggestions ) {
        return cachedSuggestions;
      }

      const obsUuid = getCurrentObservation().uuid;
      const params = {
        ...scoreImageParams,
        ...( !currentUser && { locale } ),
      };

      const attemptKey = queryKey.join( "|" );
      if ( attempts.current.key !== attemptKey ) {
        attempts.current = { key: attemptKey, count: 0 };
      }
      attempts.current.count += 1;
      const suggestionsResponse = await scoreImage(
        params,
        optsWithAuth,
        { source: "suggestions", attempt: attempts.current.count },
      ) as OnlineSuggestionsApiResponse;
      attempts.current.count = 0;

      // there's a slight discrepancy between online/offline responses which this smooths over for
      // the eventual UI
      const shimmedOnlineResponse = shimApiResponseForCommonAncestor( suggestionsResponse );
      setCachedSuggestions( cacheKey, shimmedOnlineResponse );

      if ( !!scoreImageParams && typeof obsUuid === "string" ) {
        startOfflineExperimentInBackground(
          obsUuid,
          shimmedOnlineResponse,
          () => predictOffline( {
            latitude: scoreImageParams.lat,
            longitude: scoreImageParams.lng,
            photoUri: scoreImageParams.image.uri,
            realm,
          } ),
        );
      }

      return shimmedOnlineResponse;
    },
    {
      enabled: !!shouldFetchOnlineSuggestions
        && !!scoreImageParams,
      allowAnonymousJWT: true,
    },
  );

  const onlineSuggestions = fetchedOnlineSuggestions ?? cachedOnlineSuggestions;

  useEffect( ( ) => {
    if ( onlineSuggestions !== undefined ) {
      // we're already getting all this taxon information anytime we make this API
      // call, so we might as well store it in realm immediately instead of waiting
      // for useTaxon to fetch individual taxon results
      const mappedTaxa = onlineSuggestions.results.map(
        suggestion => Taxon.mapApiToRealm( suggestion.taxon, realm ),
      );
      if ( onlineSuggestions?.common_ancestor ) {
        const mappedCommonAncestor = Taxon
          .mapApiToRealm( onlineSuggestions?.common_ancestor.taxon, realm );
        mappedTaxa.push( mappedCommonAncestor );
      }
      safeRealmWrite( realm, ( ) => {
        mappedTaxa.forEach( remoteTaxon => {
          realm.create(
            "Taxon",
            Taxon.forUpdate( remoteTaxon ),
            UpdateMode.Modified,
          );
        } );
      }, "saving remote taxon from onlineSuggestions" );
      onFetched( { isOnline: true } );
    } else if ( error ) {
      onFetchError( { isOnline: true } );
    }
  }, [onFetchError, onlineSuggestions, error, onFetched, realm] );

  return {
    dataUpdatedAt,
    error,
    refetch,
    onlineSuggestions,
  };
};

export default useOnlineSuggestions;
