import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_PADDING_FRACTION = 0.1;

// The detector's box is an estimate of where a human would crop, not the crop
// itself, and on a photo it has never seen that estimate is noisy. Missing part
// of the subject costs four times what including extra background costs, so the
// crop that scores best is not the box: it pays to hedge outward, and to hedge
// hardest where the box is small, since a small box is where a given amount of
// localization error matters most. Raising the square's side to this power does
// that — it leaves a full-frame subject alone, widens a tenth-of-the-frame
// subject by about 20%, and slightly tightens one that would letterbox.
//
// 0.92 is what the crop log picks. Fitting it on photos the detector trained on
// would choose 1.0, because the detector remembers those and its boxes are
// already right; cross-validated on held-out photos it lands on 0.92 in every
// fold, for two models with different training sets. See the tune skill.
const SIDE_CALIBRATION_EXPONENT = 0.92;

export function subjectBoundsToNormalizedCrop(
  bounds: NormalizedBounds,
  imageWidth: number,
  imageHeight: number,
  paddingFraction = DEFAULT_PADDING_FRACTION,
): NormalizedCrop {
  if (
    bounds.width <= 0
    || bounds.height <= 0
    || Number.isNaN( bounds.x )
    || Number.isNaN( bounds.y )
    || imageWidth <= 0
    || imageHeight <= 0
  ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  const paddedW = bounds.width * ( 1 + paddingFraction );
  const paddedH = bounds.height * ( 1 + paddingFraction );

  // Compute the square side in pixels so the subject fits in the square
  // container. When the subject is very large, pixelSide may exceed the image
  // dimensions; the caller is expected to letterbox rather than crop.
  const pixelSide = Math.max( paddedW * imageWidth, paddedH * imageHeight );

  // Hedge the side outward, measured against the image's longer edge so the
  // correction is scale-free and a subject filling the frame stays put.
  const maxDimension = Math.max( imageWidth, imageHeight );
  const calibratedSide = maxDimension
    * ( ( pixelSide / maxDimension ) ** SIDE_CALIBRATION_EXPONENT );

  const w = calibratedSide / imageWidth;
  const h = calibratedSide / imageHeight;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  // When the crop fits within the image, clamp position to stay in-bounds.
  // When the crop exceeds the image (letterbox case), center on the image
  // itself (not the subject) so the resulting letterboxing is split evenly
  // on both sides rather than landing unevenly on just one.
  const x = w <= 1
    ? Math.max( 0, Math.min( 1 - w, centerX - w / 2 ) )
    : ( 1 - w ) / 2;
  const y = h <= 1
    ? Math.max( 0, Math.min( 1 - h, centerY - h / 2 ) )
    : ( 1 - h ) / 2;

  return {
    x, y, w, h,
  };
}
