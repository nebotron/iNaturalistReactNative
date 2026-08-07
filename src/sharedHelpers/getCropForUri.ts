import { getAnimalCrop } from "./animalCropLog";
import detectSubjectInImage from "./detectSubjectInImage";
import type { NormalizedCrop } from "./normalizedCropTypes";
import { getThumbnailDetectedCrop } from "./useThumbnailSubjectDetection";

/**
 * Returns the best crop for a URI: crop log entry wins over AI detection.
 * This is the imperative counterpart to useSubjectDetectionForUri.
 */
const getCropForUri = async (
  remoteUri: string,
  localUri: string,
  width: number,
  height: number,
): Promise<NormalizedCrop> => {
  const loggedCrop = getAnimalCrop( remoteUri );
  // A crop already detected from this photo's thumbnail is the same normalized
  // crop the detector would return for the full-resolution file, and it's what
  // the grid the user came from is already showing. Reusing it opens the
  // cropper framed exactly as the grid was, without running detection twice.
  return loggedCrop
    ?? getThumbnailDetectedCrop( remoteUri )
    ?? detectSubjectInImage( localUri, width, height );
};

export default getCropForUri;
