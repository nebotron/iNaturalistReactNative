import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";

export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_PADDING_FRACTION = 0.1;

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

  const w = pixelSide / imageWidth;
  const h = pixelSide / imageHeight;

  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;

  // When the crop fits within the image, clamp position to stay in-bounds.
  // When the crop exceeds the image (letterbox case), center on the subject
  // and allow negative coordinates.
  const x = w <= 1
    ? Math.max( 0, Math.min( 1 - w, centerX - w / 2 ) )
    : centerX - w / 2;
  const y = h <= 1
    ? Math.max( 0, Math.min( 1 - h, centerY - h / 2 ) )
    : centerY - h / 2;

  return {
    x, y, w, h,
  };
}
