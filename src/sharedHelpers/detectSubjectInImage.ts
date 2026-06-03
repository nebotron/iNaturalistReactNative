import { NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";
import type { NormalizedBounds } from "sharedHelpers/subjectBoundsToNormalizedCrop";
import { subjectBoundsToNormalizedCrop } from "sharedHelpers/subjectBoundsToNormalizedCrop";

import { SUBJECT_DETECTION_MODEL_PADDING } from "./subjectDetectionModels";

const logger = log.extend( "detectSubjectInImage" );

interface ImageCropperModule {
  detectSubjectBounds: (
    inputPath: string,
    model: string,
  ) => Promise<NormalizedBounds | null>;
}

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

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
    const bounds = await imageCropper.detectSubjectBounds(
      stripFilePrefix( imageUri ),
      "A",
    );
    if ( !bounds ) {
      return defaultSquareCrop( imageWidth, imageHeight );
    }
    return subjectBoundsToNormalizedCrop(
      bounds,
      imageWidth,
      imageHeight,
      SUBJECT_DETECTION_MODEL_PADDING,
    );
  } catch ( error ) {
    logger.warn( "Subject detection failed, using default crop", error );
    return defaultSquareCrop( imageWidth, imageHeight );
  }
};

export default detectSubjectInImage;
