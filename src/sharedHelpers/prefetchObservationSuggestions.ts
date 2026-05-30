import type { QueryClient } from "@tanstack/react-query";
import scoreImage from "api/computerVision";
import { getJWT, isLoggedIn } from "components/LoginSignUp/AuthenticationService";
import flattenUploadParams from "components/Suggestions/helpers/flattenUploadParams";
import i18n from "i18next";
import ObservationPhoto from "realmModels/ObservationPhoto";
import type { RealmObservationPojo } from "realmModels/types";
import type { OnlineSuggestionsQueryResponse } from "sharedHooks/useSuggestions/useOnlineSuggestions";

interface OnlineSuggestionsApiResponse {
  results: OnlineSuggestionsQueryResponse["results"];
  common_ancestor?: {
    score: number;
    taxon: OnlineSuggestionsQueryResponse["results"][0]["taxon"];
  };
}

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

const prefetchObservationSuggestions = async (
  queryClient: QueryClient,
  observation: RealmObservationPojo,
): Promise<void> => {
  const photoUris = ObservationPhoto.mapObsPhotoUris( observation );
  const photoUri = photoUris[0];
  if ( !photoUri ) {
    return;
  }

  const shouldUseEvidenceLocation = !!observation.latitude;
  const scoreImageParams = await flattenUploadParams( photoUri );
  if ( shouldUseEvidenceLocation && observation.latitude ) {
    scoreImageParams.lat = observation.latitude;
    scoreImageParams.lng = observation.longitude;
  }

  const queryKey = ["scoreImage", photoUri, { shouldUseEvidenceLocation }];
  const userLoggedIn = await isLoggedIn( );
  const authQueryKey = [...queryKey, true, userLoggedIn];
  const locale = i18n?.language ?? "en";

  await queryClient.prefetchQuery( {
    queryKey: authQueryKey,
    queryFn: async ( ) => {
      const apiToken = await getJWT( true );
      const suggestionsResponse = await scoreImage(
        {
          ...scoreImageParams,
          ...( !userLoggedIn && { locale } ),
        },
        { api_token: apiToken },
      ) as OnlineSuggestionsApiResponse;

      return shimApiResponseForCommonAncestor( suggestionsResponse );
    },
  } );
};

export default prefetchObservationSuggestions;
