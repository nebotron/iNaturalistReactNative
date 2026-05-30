import { mkdir } from "@dr.pogodin/react-native-fs";
import { photoUploadPath } from "appConstants/paths";
import { NativeModules } from "react-native";
import {
  alignPixelCropOutwardToJpegBlocks,
  pixelCropFromNormalizedCrop,
} from "sharedHelpers/jpegCropBounds";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { log } from "sharedHelpers/logger";
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

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

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
    logger.error( "Failed to crop image", error );
    throw error;
  }
};

export default cropImageFile;
