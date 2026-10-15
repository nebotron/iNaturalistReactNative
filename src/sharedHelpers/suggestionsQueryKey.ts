import { getAnimalCrop } from "sharedHelpers/animalCropLog";

// How the photo is framed decides which region of it gets scored, so a framing
// the user made by hand is part of what identifies a scoring request.
export const cropSignature = ( uri?: string ): string => {
  const crop = uri
    ? getAnimalCrop( uri )
    : null;
  return crop
    ? `${crop.x},${crop.y},${crop.w},${crop.h}`
    : "";
};

// The React Query key for one online scoring request, and (via
// onlineSuggestionsCacheKey) the persistent cache key too. The Suggestions
// screen and the prefetch helper both build it from here: when they built it
// separately they drifted apart — the screen added the crop signature and the
// prefetch didn't — so every prefetched photo missed both caches and was
// scored a second time, with the request the user was waiting on queued behind
// the very prefetches that had already scored it.
export const onlineSuggestionsQueryKey = (
  photoUri: string,
  shouldUseEvidenceLocation: boolean,
): unknown[] => [
  "scoreImage",
  photoUri,
  { shouldUseEvidenceLocation },
  cropSignature( photoUri ),
];

export default onlineSuggestionsQueryKey;
