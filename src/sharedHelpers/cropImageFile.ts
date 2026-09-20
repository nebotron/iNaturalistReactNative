import { mkdir } from "@dr.pogodin/react-native-fs";
import { photoUploadPath } from "appConstants/paths";
import { NativeModules } from "react-native";
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
  ) => Promise<string>;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: ImageCropperModule;
};

const cropImageFile = async (
  imageUri: string,
  crop: NormalizedCrop,
  imageWidth: number,
  imageHeight: number,
  outputDir = photoUploadPath,
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
    const croppedPath = await ImageCropper.cropImage(
      inputPath,
      pixelCrop.originX,
      pixelCrop.originY,
      pixelCrop.width,
      pixelCrop.height,
      outputPath,
    );
    // Native ImageCropper copies EXIF/metadata from the source image into the
    // cropped JPEG and updates dimension/orientation tags for the new size.
    return croppedPath.startsWith( "file://" )
      ? croppedPath
      : `file://${croppedPath}`;
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
