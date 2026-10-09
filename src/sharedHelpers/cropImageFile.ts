import { mkdir, unlink } from "@dr.pogodin/react-native-fs";
import { photoUploadPath } from "appConstants/paths";
import { NativeModules } from "react-native";
import adjustImageBrightness from "sharedHelpers/adjustImageBrightness";
import {
  alignPixelCropOutwardToJpegBlocks,
  pixelCropFromNormalizedCrop,
} from "sharedHelpers/jpegCropBounds";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import * as uuid from "uuid";

const logger = log.extend( "cropImageFile" );

interface ImageCropperModule {
  cropImage: (
    inputPath: string,
    originX: number,
    originY: number,
    width: number,
    height: number,
    outputPath: string,
  ) => Promise<CropResult>;
}

interface CropResult {
  path: string;
  // "decode" when the crop came from the photo itself, "preview" when that
  // decode produced nothing, and "preview_dark_decode" when it came back far
  // darker than the camera's embedded preview of the same frame.
  origin: string;
  // Mean levels (0-255) of the decoded crop, the preview crop (-1 when not
  // compared), and what was written.
  level: number;
  previewLevel: number;
  outputLevel: number;
  // Decodes it took; a raw that failed is tried again.
  attempts: number;
}

// Below this, a written crop is dark enough to be worth a line in the log.
const DARK_OUTPUT_LEVEL = 24;

const { ImageCropper } = NativeModules as {
  ImageCropper?: ImageCropperModule;
};

const cropImageFile = async (
  imageUri: string,
  crop: NormalizedCrop,
  imageWidth: number,
  imageHeight: number,
  outputDir = photoUploadPath,
  // Exposure gain from the crop editor's brightness slider, baked into the
  // cropped file. 1 leaves the pixels untouched.
  brightness = 1,
): Promise<string> => {
  if ( !ImageCropper?.cropImage ) {
    throw new Error( "ImageCropper native module is unavailable" );
  }

  await mkdir( outputDir );
  const outputPath = `${outputDir}/${uuid.v4()}.jpg`;
  const inputPath = stripFilePrefix( imageUri );

  const pixelCrop = alignPixelCropOutwardToJpegBlocks(
    pixelCropFromNormalizedCrop( crop, imageWidth, imageHeight ),
    imageWidth,
    imageHeight,
  );

  try {
    const result = await ImageCropper.cropImage(
      inputPath,
      pixelCrop.originX,
      pixelCrop.originY,
      pixelCrop.width,
      pixelCrop.height,
      outputPath,
    );
    const croppedPath = result.path;
    // A crop that turned out black reached the grid with no error behind it.
    // Say where its pixels came from and how bright they were.
    if (
      result.origin !== "decode"
      || result.outputLevel < DARK_OUTPUT_LEVEL
      || result.attempts > 1
    ) {
      logger.warnWithExtra( "crop_output_check", {
        source: imageUri,
        origin: result.origin,
        level: result.level,
        previewLevel: result.previewLevel,
        outputLevel: result.outputLevel,
        attempts: result.attempts,
      } );
    }
    // Native ImageCropper copies EXIF/metadata from the source image into the
    // cropped JPEG and updates dimension/orientation tags for the new size.
    const croppedUri = croppedPath.startsWith( "file://" )
      ? croppedPath
      : `file://${croppedPath}`;
    if ( brightness === 1 ) return croppedUri;
    const adjustedUri = await adjustImageBrightness(
      croppedUri,
      brightness,
      Number.MAX_SAFE_INTEGER,
      `${outputDir}/${uuid.v4()}.jpg`,
    );
    if ( !adjustedUri ) {
      logger.warnWithExtra( "crop_brightness_failed", { source: imageUri, brightness } );
      return croppedUri;
    }
    await unlink( stripFilePrefix( croppedUri ) ).catch( ( ) => undefined );
    return adjustedUri;
  } catch ( error ) {
    // The crop the user framed is lost to a "Something went wrong" alert, so
    // this line is the only record of which photo it was. Without the geometry
    // and the source, eleven of these in the Sep 18-19 log said nothing beyond
    // the fact that it happened.
    logger.errorWithExtra( "crop_failed", {
      source: imageUri,
      imageWidth,
      imageHeight,
      originX: pixelCrop.originX,
      originY: pixelCrop.originY,
      cropWidth: pixelCrop.width,
      cropHeight: pixelCrop.height,
      error: error instanceof Error
        ? error.message
        : String( error ),
    } );
    throw error;
  }
};

export default cropImageFile;
