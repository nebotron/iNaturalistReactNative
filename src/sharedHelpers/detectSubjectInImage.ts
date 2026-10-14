import { NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import type { NormalizedBounds } from "sharedHelpers/subjectBoundsToNormalizedCrop";
import { subjectBoundsToNormalizedCrop } from "sharedHelpers/subjectBoundsToNormalizedCrop";

const logger = log.extend( "detectSubjectInImage" );

// No extra padding: the detector's bounds are already framed as we want them.
const SUBJECT_DETECTION_PADDING = 0;

interface ImageCropperModule {
  detectSubjectBounds: ( inputPath: string ) => Promise<NormalizedBounds | null>;
}

// The crop the detector's bounds describe, or the default framing when it
// found nothing. Shared with prepareCropSource, which gets its bounds from the
// same detector through a different native call.
export const subjectCropFromBounds = (
  bounds: NormalizedBounds | null,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop => ( bounds
  ? subjectBoundsToNormalizedCrop( bounds, imageWidth, imageHeight, SUBJECT_DETECTION_PADDING )
  : defaultSquareCrop( imageWidth, imageHeight ) );

const detectSubjectInImage = async (
  imageUri: string,
  imageWidth: number,
  imageHeight: number,
): Promise<NormalizedCrop> => {
  const imageCropper = ( NativeModules as { ImageCropper?: ImageCropperModule } ).ImageCropper;
  if ( !imageCropper?.detectSubjectBounds ) {
    return defaultSquareCrop( imageWidth, imageHeight );
  }

  try {
    const bounds = await imageCropper.detectSubjectBounds( stripFilePrefix( imageUri ) );
    return subjectCropFromBounds( bounds, imageWidth, imageHeight );
  } catch ( error ) {
    logger.warn( "Subject detection failed, using default crop", error );
    return defaultSquareCrop( imageWidth, imageHeight );
  }
};

export default detectSubjectInImage;
