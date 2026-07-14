import { NativeModules } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

export interface CropLuminance {
  geomean: number;
  median: number;
}

interface ImageCropperModule {
  measureImageBrightness: (
    path: string,
    cropX: number | null,
    cropY: number | null,
    cropW: number | null,
    cropH: number | null,
  ) => Promise<CropLuminance | null>;
}

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// Returns the geometric-mean and median perceptual luminance (each in [0, 1])
// within the given crop region, or null on failure. Pass crop=null to
// measure the full image.
const measureImageBrightness = async (
  imageUri: string,
  crop: NormalizedCrop | null = null,
): Promise<CropLuminance | null> => {
  const imageCropper = ( NativeModules as { ImageCropper?: ImageCropperModule } ).ImageCropper;
  if ( !imageCropper?.measureImageBrightness ) return null;
  try {
    const result = await imageCropper.measureImageBrightness(
      stripFilePrefix( imageUri ),
      crop ? crop.x : null,
      crop ? crop.y : null,
      crop ? crop.w : null,
      crop ? crop.h : null,
    );
    return result && result.geomean >= 0 && result.median >= 0
      ? result
      : null;
  } catch {
    return null;
  }
};

export default measureImageBrightness;
