import { useNetInfo } from "@react-native-community/netinfo";
import { useMemo } from "react";

import filterSuggestions from "./filterSuggestions";
import type { UseSuggestionsOptions, UseSuggestionsResult } from "./types";
import useOfflineSuggestions from "./useOfflineSuggestions";
import useOnlineSuggestions from "./useOnlineSuggestions";

const useSuggestions = (
  photoUri: string,
  options: UseSuggestionsOptions,
): UseSuggestionsResult => {
  const { isConnected } = useNetInfo( );
  const {
    shouldFetchOnlineSuggestions,
    onFetchError,
    onFetched,
    scoreImageParams,
    queryKey,
    preferOfflineModel = false,
  } = options;

  const {
    dataUpdatedAt: onlineSuggestionsUpdatedAt,
    error: onlineSuggestionsError,
    onlineSuggestions,
    refetch: refetchOnlineSuggestions,
    timedOut,
    resetTimeout,
  } = useOnlineSuggestions( {
    onFetchError,
    onFetched,
    scoreImageParams,
    queryKey,
    shouldFetchOnlineSuggestions: preferOfflineModel
      ? false
      : shouldFetchOnlineSuggestions,
  } );

  const onlineSuggestionsResponse = {
    onlineSuggestionsUpdatedAt,
    onlineSuggestionsError,
    onlineSuggestions,
    timedOut,
    resetTimeout,
  };

  // 20240815 amanda - it's conceivable that we would want to use a cached image here eventually,
  // since the user can see the small square version of this image in MyObs/ObsDetails already
  // but for now, passing in an https photo to predictImage while offline crashes the app
  const urlWillCrashOffline = photoUri?.includes( "https://" ) && !isConnected;

  // show offline suggestions immediately, online suggestions replace them once they arrive
  const tryOfflineSuggestions = !urlWillCrashOffline;

  const {
    offlineSuggestions,
    refetchOfflineSuggestions,
  } = useOfflineSuggestions( photoUri, {
    onFetched,
    onFetchError,
    latitude: scoreImageParams?.lat,
    longitude: scoreImageParams?.lng,
    tryOfflineSuggestions,
  } );

  const refetchSuggestions = () => {
    if ( shouldFetchOnlineSuggestions ) {
      refetchOnlineSuggestions();
    }
    if ( tryOfflineSuggestions ) {
      refetchOfflineSuggestions();
    }
  };

  const hasOnlineSuggestionResults = !preferOfflineModel
    && ( onlineSuggestions?.results?.length || 0 ) > 0;

  // offline results are shown by default; switch to online results once they're in
  const usingOfflineSuggestions = preferOfflineModel || !hasOnlineSuggestionResults;

  const unfilteredSuggestions = useMemo(
    ( ) => {
      if ( preferOfflineModel ) {
        return offlineSuggestions?.results || [];
      }
      if ( hasOnlineSuggestionResults ) {
        return onlineSuggestions?.results || [];
      }
      return offlineSuggestions?.results || [];
    },
    [
      preferOfflineModel,
      hasOnlineSuggestionResults,
      onlineSuggestions,
      offlineSuggestions,
    ],
  );

  const commonAncestor = preferOfflineModel || !hasOnlineSuggestionResults
    ? offlineSuggestions?.commonAncestor
    : onlineSuggestions?.common_ancestor;

  // since we can calculate this, there's no need to store it in state
  const suggestions = useMemo(
    ( ) => filterSuggestions(
      unfilteredSuggestions,
      commonAncestor,
    ),
    [
      unfilteredSuggestions,
      commonAncestor,
    ],
  );

  return {
    ...onlineSuggestionsResponse,
    suggestions,
    usingOfflineSuggestions,
    tryOfflineSuggestions,
    urlWillCrashOffline,
    refetchSuggestions,
  };
};

export default useSuggestions;
