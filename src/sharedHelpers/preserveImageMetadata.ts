import { NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";

const logger = log.extend( "preserveImageMetadata" );

interface ImageCropperModule {
  preserveImageMetadata: (
    sourcePath: string,
    destPath: string,
    width: number,
    height: number,
  ) => Promise<string>;
}

const { ImageCropper } = NativeModules as {
  ImageCropper?: ImageCropperModule;
};

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

const preserveImageMetadata = async (
  sourceUri: string,
  destUri: string,
  width: number,
  height: number,
): Promise<string> => {
  if ( !ImageCropper?.preserveImageMetadata ) {
    logger.warn( "ImageCropper.preserveImageMetadata is unavailable" );
    return destUri;
  }

  const sourcePath = stripFilePrefix( sourceUri );
  const destPath = stripFilePrefix( destUri );

  try {
    const outputPath = await ImageCropper.preserveImageMetadata(
      sourcePath,
      destPath,
      width,
      height,
    );
    return outputPath.startsWith( "file://" )
      ? outputPath
      : `file://${outputPath}`;
  } catch ( error ) {
    logger.error( "Failed to preserve image metadata after crop", error );
    return destUri;
  }
};

export default preserveImageMetadata;
