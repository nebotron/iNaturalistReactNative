import { NativeModules } from "react-native";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";

interface ImageCropperModule {
  adjustImageBrightness: (
    path: string,
    adjustment: number,
    maxDimension: number,
    outputPath: string,
  ) => Promise<string>;
}

// Multiplies each channel by the brightness gain and clamps to [0, 255] (see
// applyBrightnessMultiplyBuffer in the native implementation), the same
// operation the CSS brightness() filter applies to the live slider preview, so
// the baked result matches what the slider showed. Returns a file:// uri for
// the adjusted image, or null on failure.
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
