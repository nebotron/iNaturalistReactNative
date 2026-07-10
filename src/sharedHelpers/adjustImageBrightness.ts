import { NativeModules } from "react-native";

interface ImageCropperModule {
  adjustImageBrightness: (
    path: string,
    adjustment: number,
    maxDimension: number,
    outputPath: string,
  ) => Promise<string>;
}

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// Applies a detail-preserving tone curve (see toneCurve/toneCurveChannel in
// the native implementations) instead of a flat multiply, so brightening
// can't clip highlights to white and darkening can't crush shadows to black.
// Returns a file:// uri for the adjusted image, or null on failure.
const adjustImageBrightness = async (
  imageUri: string,
  adjustment: number,
  maxDimension: number,
  outputPath: string,
): Promise<string | null> => {
  const imageCropper = ( NativeModules as { ImageCropper?: ImageCropperModule } ).ImageCropper;
  if ( !imageCropper?.adjustImageBrightness ) return null;
  try {
    const result = await imageCropper.adjustImageBrightness(
      stripFilePrefix( imageUri ),
      adjustment,
      maxDimension,
      stripFilePrefix( outputPath ),
    );
    return result
      ? `file://${stripFilePrefix( result )}`
      : null;
  } catch {
    return null;
  }
};

export default adjustImageBrightness;
