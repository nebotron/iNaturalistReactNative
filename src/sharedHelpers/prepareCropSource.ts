import { cropSourcesPath } from "appConstants/paths";
import { NativeModules } from "react-native";
import { getAnimalCrop } from "sharedHelpers/animalCropLog";
import type { DetectedBounds } from "sharedHelpers/detectSubjectInImage";
import {
  logSubjectDetectionTiming,
  subjectCropFromBounds,
} from "sharedHelpers/detectSubjectInImage";
import getCropForUri from "sharedHelpers/getCropForUri";
import imageFileSize from "sharedHelpers/imageFileSize";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

const logger = log.extend( "prepareCropSource" );

// Longest side of the file the cropper displays. Large enough to never
// downscale, so the cropper draws the photo at full resolution.
const DISPLAY_MAX_PIXEL = 99999;

interface PreparedSource {
  // The file the cropper draws. The crop itself is still applied to the
  // original.
  displayUri: string;
  // Dimensions of the original as a decoder sees it, which is the pixel space
  // the crop is expressed in.
  size: { w: number; h: number };
  crop: NormalizedCrop;
  // Native stage durations (queue and lock waits, decode, encode, write,
  // detection), for telling a slow prepare's waiting from its work.
  stageMs?: Record<string, number>;
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
    bounds: DetectedBounds | null;
    // Mean level (0-255) of the display file.
    displayLevel: number;
    // Decodes it took, and how long each ran; a raw that failed is tried again.
    attempts: number;
    attemptMs: number[];
    stageMs?: Record<string, number>;
    // A raw's free memory at each try, and how long it waited for it.
    attemptFreeMB?: number[];
    attemptWaitMs?: number[];
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
// initial framing. Reads the size and detects separately (each its own decode)
// wherever the native call isn't available.
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
    ).catch( ( error: Error & { userInfo?: { diagnostics?: unknown } } ) => {
      logger.errorWithExtra( "crop_source_prepare_failed", {
        source: sourceUri,
        error: error?.message ?? String( error ),
        // Why a raw decode drew nothing (see rawDecodeFailureDiagnostics).
        diagnostics: error?.userInfo?.diagnostics,
      } );
      return null;
    } );
    if ( prepared && (
      prepared.displayLevel < 24
      || prepared.attempts > 1
      || prepared.attemptWaitMs?.some( ms => ms > 0 )
    ) ) {
      // The cropper is about to draw a near-black frame, or a raw needed
      // another decode, or a wait for memory, to come out at all.
      logger.warnWithExtra( "crop_source_dark", {
        source: sourceUri,
        displayLevel: prepared.displayLevel,
        attempts: prepared.attempts,
        attemptMs: prepared.attemptMs,
        attemptFreeMB: prepared.attemptFreeMB,
        attemptWaitMs: prepared.attemptWaitMs,
      } );
    }
    if ( !prepared || prepared.width <= 0 || prepared.height <= 0 ) {
      return null;
    }
    logSubjectDetectionTiming( prepared.bounds );
    const size = { w: prepared.width, h: prepared.height };
    return {
      displayUri: prepared.displayUri,
      size,
      crop: knownCrop ?? subjectCropFromBounds( prepared.bounds, size.w, size.h ),
      stageMs: prepared.stageMs && {
        ...prepared.stageMs,
        ...( prepared.bounds?.detectMs !== undefined && { detect: prepared.bounds.detectMs } ),
      },
    };
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
