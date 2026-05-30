import { getAnimalCrop } from "./animalCropLog";
import detectSubjectInImage from "./detectSubjectInImage";
import type { NormalizedCrop } from "./normalizedCropTypes";

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
  return loggedCrop ?? detectSubjectInImage( localUri, width, height );
};

export default getCropForUri;
