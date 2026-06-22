import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform } from "sharedHelpers/normalizedCropToImageZoomTransform";

export interface CropPanSnapPositions {
  snapTotalTranslateX: [number, number, number];
  snapTotalTranslateY: [number, number, number];
}

export interface CropPanContext {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  cropSize: number;
}

export interface CropPanTranslateLimits {
  minTotalTranslateX: number;
  maxTotalTranslateX: number;
  minTotalTranslateY: number;
  maxTotalTranslateY: number;
}

export function computeCropPanTranslateLimits(
  context: CropPanContext,
  transform: ImageZoomTransform,
): CropPanTranslateLimits {
  "worklet";

  const {
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
  } = context;

  if (
    imageWidth <= 0
    || imageHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
    || cropSize <= 0
    || transform.scale <= 0
  ) {
    return {
      minTotalTranslateX: 0,
      maxTotalTranslateX: 0,
      minTotalTranslateY: 0,
      maxTotalTranslateY: 0,
    };
  }

  const crop = imageZoomTransformToNormalizedCrop(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    transform,
  );

  const leftTransform = normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x: 0,
      y: Math.max( 0, Math.min( 1 - crop.h, crop.y ) ),
      w: crop.w,
      h: crop.h,
    },
  );
  const rightTransform = normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x: Math.max( 0, 1 - crop.w ),
      y: Math.max( 0, Math.min( 1 - crop.h, crop.y ) ),
      w: crop.w,
      h: crop.h,
    },
  );
  const topTransform = normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x: Math.max( 0, Math.min( 1 - crop.w, crop.x ) ),
      y: 0,
      w: crop.w,
      h: crop.h,
    },
  );
  const bottomTransform = normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x: Math.max( 0, Math.min( 1 - crop.w, crop.x ) ),
      y: Math.max( 0, 1 - crop.h ),
      w: crop.w,
      h: crop.h,
    },
  );

  const leftTotalX = leftTransform.translateX + leftTransform.focalX;
  const rightTotalX = rightTransform.translateX + rightTransform.focalX;
  const topTotalY = topTransform.translateY + topTransform.focalY;
  const bottomTotalY = bottomTransform.translateY + bottomTransform.focalY;

  return {
    minTotalTranslateX: Math.min( leftTotalX, rightTotalX ),
    maxTotalTranslateX: Math.max( leftTotalX, rightTotalX ),
    minTotalTranslateY: Math.min( topTotalY, bottomTotalY ),
    maxTotalTranslateY: Math.max( topTotalY, bottomTotalY ),
  };
}

/**
 * Compute the three discrete snap positions for the crop editor:
 * left/top edge (0-sided letterboxing), center (2-sided equal letterboxing),
 * and right/bottom edge (0-sided letterboxing).
 *
 * On release, the image snaps to whichever of these three positions is nearest
 * to the current translate position, per axis independently.
 */
export function computeCropPanSnapPositions(
  context: CropPanContext,
  transform: ImageZoomTransform,
): CropPanSnapPositions {
  "worklet";

  const {
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
  } = context;

  if (
    imageWidth <= 0
    || imageHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
    || cropSize <= 0
    || transform.scale <= 0
  ) {
    return {
      snapTotalTranslateX: [0, 0, 0],
      snapTotalTranslateY: [0, 0, 0],
    };
  }

  const crop = imageZoomTransformToNormalizedCrop(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    transform,
  );

  const safeY = Math.max( 0, Math.min( 1 - crop.h, crop.y ) );
  const safeX = Math.max( 0, Math.min( 1 - crop.w, crop.x ) );

  const makeTransformX = ( x: number ) => normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x,
      y: safeY,
      w: crop.w,
      h: crop.h,
    },
  );

  const makeTransformY = ( y: number ) => normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    cropSize,
    {
      x: safeX,
      y,
      w: crop.w,
      h: crop.h,
    },
  );

  const leftT = makeTransformX( 0 );
  const centerXT = makeTransformX( ( 1 - crop.w ) / 2 );
  const rightT = makeTransformX( Math.max( 0, 1 - crop.w ) );

  const topT = makeTransformY( 0 );
  const centerYT = makeTransformY( ( 1 - crop.h ) / 2 );
  const bottomT = makeTransformY( Math.max( 0, 1 - crop.h ) );

  return {
    snapTotalTranslateX: [
      leftT.translateX + leftT.focalX,
      centerXT.translateX + centerXT.focalX,
      rightT.translateX + rightT.focalX,
    ],
    snapTotalTranslateY: [
      topT.translateY + topT.focalY,
      centerYT.translateY + centerYT.focalY,
      bottomT.translateY + bottomT.focalY,
    ],
  };
}
