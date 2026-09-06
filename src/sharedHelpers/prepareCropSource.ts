import { cropSourcesPath } from "appConstants/paths";
import { NativeModules } from "react-native";
import { getAnimalCrop } from "sharedHelpers/animalCropLog";
import { subjectCropFromBounds } from "sharedHelpers/detectSubjectInImage";
import getCropForUri from "sharedHelpers/getCropForUri";
import imageFileSize from "sharedHelpers/imageFileSize";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import type { NormalizedBounds } from "sharedHelpers/subjectBoundsToNormalizedCrop";

// Longest side of the file the cropper displays. A crop is capped at 2048 on
// upload however it was framed, so this is every pixel the user can end up
// with -- and a fraction of the ~24 megapixels of an original, which is what
// the editor used to hand React Native to decode for each photo.
const DISPLAY_MAX_PIXEL = 2048;

interface PreparedSource {
  // The file the cropper draws. The crop itself is still applied to the
  // original, so this being smaller costs no quality in the saved photo.
  displayUri: string;
  // Dimensions of the original as a decoder sees it, which is the pixel space
  // the crop is expressed in.
  size: { w: number; h: number };
  crop: NormalizedCrop;
}

interface ImageCropperModule {
  prepareCropSource?: (
    inputPath: string,
    maxPixel: number,
    outputPath: string,
    detectSubject: boolean,
  ) => Promise<{
    displayUri: string;
    width: number;
    height: number;
    bounds: NormalizedBounds | null;
  }>;
}

// djb2 hash → a stable filename per source, so a photo revisited in the same
// session (or after the editor was left and re-entered) reuses the file it
// already decoded. cropSourcesPath is swept by TTL on launch.
const displayPathFor = ( uri: string ): string => {
  let hash = 5381;
  for ( let i = 0; i < uri.length; i += 1 ) {
    // eslint-disable-next-line no-bitwise
    hash = ( ( ( hash << 5 ) + hash ) ^ uri.charCodeAt( i ) ) >>> 0;
  }
  return `${cropSourcesPath}/${hash.toString( 16 )}-display.jpg`;
};

// Everything the crop editor needs from a photo, from one decode of it: the
// dimensions a crop is expressed against, a display-sized file to draw, and the
// initial framing. Falls back to reading the size and detecting separately
// (each its own decode) wherever the native call isn't available.
const prepareCropSource = async (
  imageUri: string,
  sourceUri: string,
  existingSavedCrop: NormalizedCrop | null,
): Promise<PreparedSource | null> => {
  const { ImageCropper } = NativeModules as { ImageCropper?: ImageCropperModule };
  // A crop the user already made, or one the crop log remembers for this photo,
  // both outrank detection -- so there is no subject to detect.
  const knownCrop = existingSavedCrop ?? getAnimalCrop( imageUri );

  if ( ImageCropper?.prepareCropSource ) {
    const prepared = await ImageCropper.prepareCropSource(
      sourceUri,
      DISPLAY_MAX_PIXEL,
      displayPathFor( sourceUri ),
      !knownCrop,
    ).catch( ( ) => null );
    if ( prepared && prepared.width > 0 && prepared.height > 0 ) {
      const size = { w: prepared.width, h: prepared.height };
      return {
        displayUri: prepared.displayUri,
        size,
        crop: knownCrop ?? subjectCropFromBounds( prepared.bounds, size.w, size.h ),
      };
    }
  }

  const size = await imageFileSize( sourceUri );
  if ( !size ) {
    return null;
  }
  return {
    displayUri: sourceUri,
    size,
    crop: knownCrop ?? await getCropForUri( imageUri, sourceUri, size.w, size.h ),
  };
};

export default prepareCropSource;
