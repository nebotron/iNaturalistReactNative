import { NativeModules } from "react-native";

interface ImageCropperModule {
  measureImageBrightness: ( path: string ) => Promise<number>;
}

const stripFilePrefix = ( uri: string ) => uri.replace( /^file:\/\//, "" );

// Returns average perceptual luminance in [0, 1], or null on failure.
const measureImageBrightness = async ( imageUri: string ): Promise<number | null> => {
  const imageCropper = ( NativeModules as { ImageCropper?: ImageCropperModule } ).ImageCropper;
  if ( !imageCropper?.measureImageBrightness ) return null;
  try {
    const result = await imageCropper.measureImageBrightness( stripFilePrefix( imageUri ) );
    return result >= 0 ? result : null;
  } catch {
    return null;
  }
};

export default measureImageBrightness;
