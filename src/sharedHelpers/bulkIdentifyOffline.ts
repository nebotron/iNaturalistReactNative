import type Realm from "realm";
import ObservationPhoto from "realmModels/ObservationPhoto";
import type { RealmObservationPojo } from "realmModels/types";
import { getCachedSuggestions, setCachedSuggestions } from "sharedHelpers/suggestionsCache";
import filterSuggestions from "sharedHooks/useSuggestions/filterSuggestions";
import {
  getOfflinePredictionCacheKey,
  predictOffline,
  type OfflineSuggestionsResponse,
} from "sharedHooks/useSuggestions/useOfflineSuggestions";

// Runs the on-device model for an observation's first photo and returns the
// confidence (combined_score) of its top species suggestion, or 0 when there
// isn't a confident one. Results are cached under the same key
// useOfflineSuggestions reads, so opening the observation shows them instantly.
const scoreObservationOffline = async (
  realm: Realm,
  observation: RealmObservationPojo,
): Promise<number> => {
  const photoUri = ObservationPhoto.mapObsPhotoUris( observation )[0];
  if ( !photoUri ) {
    return -1;
  }
  const latitude = observation.latitude ? observation.latitude : undefined;
  const longitude = observation.latitude ? observation.longitude : undefined;

  const cacheKey = getOfflinePredictionCacheKey( photoUri, latitude, longitude );
  let suggestions = getCachedSuggestions<OfflineSuggestionsResponse>( cacheKey );
  if ( !suggestions ) {
    suggestions = await predictOffline( {
      latitude, longitude, photoUri, realm,
    } );
    if ( !suggestions ) {
      return -1;
    }
    setCachedSuggestions( cacheKey, suggestions );
  }

  const { topSuggestion } = filterSuggestions(
    suggestions.results,
    suggestions.commonAncestor,
  );
  return topSuggestion?.combined_score ?? 0;
};

export default scoreObservationOffline;
