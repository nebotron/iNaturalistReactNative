import { NativeModules } from "react-native";
import { log } from "sharedHelpers/logger";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";
import stripFilePrefix from "sharedHelpers/stripFilePrefix";
import type { NormalizedBounds } from "sharedHelpers/subjectBoundsToNormalizedCrop";
import { subjectBoundsToNormalizedCrop } from "sharedHelpers/subjectBoundsToNormalizedCrop";

const logger = log.extend( "detectSubjectInImage" );

// No extra padding: the detector's bounds are already framed as we want them.
const SUBJECT_DETECTION_PADDING = 0;

// Bounds as the native detector returns them, with how long it took: in all,
// per detector view (preprocessing included), and whether saliency stood in.
export interface DetectedBounds extends NormalizedBounds {
  detectMs?: number;
  viewMs?: number[];
  saliency?: boolean;
}

interface ImageCropperModule {
  detectSubjectBounds: ( inputPath: string ) => Promise<DetectedBounds | null>;
}

// Detection runs for every tile of a photo grid, so timings are summarized
// every TIMING_BATCH detections rather than logged one by one
const TIMING_BATCH = 100;
let timings: DetectedBounds[] = [];

const mean = ( values: number[] ) => Math.round(
  values.reduce( ( sum, v ) => sum + v, 0 ) / Math.max( values.length, 1 ),
);

export const logSubjectDetectionTiming = ( bounds: DetectedBounds | null ) => {
  if ( bounds?.detectMs === undefined ) {
    return;
  }
  timings.push( bounds );
  if ( timings.length < TIMING_BATCH ) {
    return;
  }
  const batch = timings;
  timings = [];
  const detectMs = batch.map( b => b.detectMs as number );
  const views = Math.max( ...batch.map( b => b.viewMs?.length || 0 ) );
  logger.infoWithExtra( "subject_detection_timing", {
    count: batch.length,
    meanMs: mean( detectMs ),
    maxMs: Math.max( ...detectMs ),
    meanViewMs: Array.from( { length: views }, ( _, i ) => mean(
      batch.flatMap( b => ( b.viewMs?.[i] === undefined
        ? []
        : [b.viewMs[i]] ) ),
    ) ),
    saliency: batch.filter( b => b.saliency ).length,
  } );
};

// The crop the detector's bounds describe, or the default framing when it
// found nothing. Shared with prepareCropSource, which gets its bounds from the
// same detector through a different native call.
export const subjectCropFromBounds = (
  bounds: NormalizedBounds | null,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop => ( bounds
  ? subjectBoundsToNormalizedCrop( bounds, imageWidth, imageHeight, SUBJECT_DETECTION_PADDING )
  : defaultSquareCrop( imageWidth, imageHeight ) );

const detectSubjectInImage = async (
  imageUri: string,
  imageWidth: number,
  imageHeight: number,
): Promise<NormalizedCrop> => {
  const imageCropper = ( NativeModules as { ImageCropper?: ImageCropperModule } ).ImageCropper;
  if ( !imageCropper?.detectSubjectBounds ) {
    return defaultSquareCrop( imageWidth, imageHeight );
  }

  try {
    const bounds = await imageCropper.detectSubjectBounds( stripFilePrefix( imageUri ) );
    logSubjectDetectionTiming( bounds );
    return subjectCropFromBounds( bounds, imageWidth, imageHeight );
  } catch ( error ) {
    logger.warn( "Subject detection failed, using default crop", error );
    return defaultSquareCrop( imageWidth, imageHeight );
  }
};

export default detectSubjectInImage;
