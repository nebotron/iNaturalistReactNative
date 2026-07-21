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

// Applies exposure (a linear-light multiply, see applyExposurePreservingColor
// in the native implementation) rather than multiplying gamma-encoded pixel
// values directly, which would compress midtone/highlight contrast and look
// flat. The multiply is color-preserving: highlights that clip are scaled by
// their shared maximum so the pixel's hue stays put instead of skewing as
// individual channels reach white. Returns a file:// uri for the adjusted
// image, or null on failure.
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
