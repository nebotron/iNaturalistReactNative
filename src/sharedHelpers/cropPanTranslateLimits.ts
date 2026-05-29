import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";

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
