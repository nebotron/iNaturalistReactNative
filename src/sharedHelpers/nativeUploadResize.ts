import { photoUploadPath } from "appConstants/paths";
import { Image, NativeModules, Platform } from "react-native";
import { log } from "sharedHelpers/logger";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import { getTunable } from "sharedHelpers/tunableParams";
import * as uuid from "uuid";

const logger = log.extend( "nativeUploadResize" );

const UPLOAD_MAX_DIMENSION = getTunable( "uploadMaxDimension" );

interface NativeModulesWithResize {
  ImageCropper?: {
    resizeForUpload?: (
      inputPath: string,
      maxPixel: number,
      outputPath: string,
    ) => Promise<{ path: string; reencoded: boolean; width: number; height: number }>;
  };
}

// iOS: the upload copy written by ImageCropper.resizeForUpload, which keeps
// the photo's colour space, downsamples through ImageIO, encodes once, and
// copies the bytes instead of re-encoding when the file is already an upright
// JPEG within the upload size (every crop). Null when it isn't available or
// fails, and the caller falls back to the resizer.
export const resizeNativelyForUpload = async ( pathOrUri: string ): Promise<string | null> => {
  const resizeForUpload = ( NativeModules as NativeModulesWithResize )
    .ImageCropper?.resizeForUpload;
  if ( Platform.OS !== "ios" || !resizeForUpload ) return null;
  try {
    const { path } = await resizeForUpload(
      stripFilePrefix( pathOrUri ),
      UPLOAD_MAX_DIMENSION,
      `${photoUploadPath}/${uuid.v4( )}.jpg`,
    );
    return `file://${path}`;
  } catch ( error ) {
    logger.warn( "Native upload resize failed, falling back to the resizer", error );
    return null;
  }
};

// Whether a local image is already within the upload size, so resizing it
// again would only re-encode it. False when its size can't be read.
export const isWithinUploadSize = async ( uri: string ): Promise<boolean> => {
  try {
    const { width, height } = await Image.getSize( uri );
    return Math.max( width, height ) <= UPLOAD_MAX_DIMENSION;
  } catch {
    return false;
  }
};
