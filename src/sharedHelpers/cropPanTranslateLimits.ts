import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform }
  from "sharedHelpers/normalizedCropToImageZoomTransform";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";

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

// Minimum zoom scale at which the crop square is no larger than the image's
// longer dimension. Zooming out below this would grow the crop past the larger
// image edge (leaving the crop bigger than the image on both axes), which is
// never allowed. At exactly this scale the crop spans the longer image
// dimension; the shorter dimension remains free per the boundary rules.
export function computeCropMinScale( context: CropPanContext ): number {
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
  ) {
    return 0;
  }

  const contain = computeContainRect( viewportWidth, viewportHeight, imageWidth, imageHeight );
  const longerContain = Math.max( contain.width, contain.height );
  if ( longerContain <= 0 ) {
    return 0;
  }

  return cropSize / longerContain;
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

  const contain = computeContainRect( viewportWidth, viewportHeight, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) {
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

  // Crop size as a fraction of each image dimension at the current zoom,
  // before clamping to the image edges. When this exceeds 1 the crop window
  // is bigger than the image along that axis (e.g. a square crop window on
  // a non-square image once it grows past the shorter edge), so no position
  // keeps it fully inside on that axis. On that axis the image is pinned
  // centered within the crop box (total translate 0, since the crop box is
  // centered in the viewport) -- the default 0/0 limits below. The other
  // axis (the longer image dimension) still confines the crop normally.
  const cropFractionW = cropSize / ( transform.scale * contain.width );
  const cropFractionH = cropSize / ( transform.scale * contain.height );

  let minTotalTranslateX = 0;
  let maxTotalTranslateX = 0;
  if ( cropFractionW <= 1 ) {
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
    const leftTotalX = leftTransform.translateX + leftTransform.focalX;
    const rightTotalX = rightTransform.translateX + rightTransform.focalX;
    minTotalTranslateX = Math.min( leftTotalX, rightTotalX );
    maxTotalTranslateX = Math.max( leftTotalX, rightTotalX );
  }

  let minTotalTranslateY = 0;
  let maxTotalTranslateY = 0;
  if ( cropFractionH <= 1 ) {
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
    const topTotalY = topTransform.translateY + topTransform.focalY;
    const bottomTotalY = bottomTransform.translateY + bottomTransform.focalY;
    minTotalTranslateY = Math.min( topTotalY, bottomTotalY );
    maxTotalTranslateY = Math.max( topTotalY, bottomTotalY );
  }

  return {
    minTotalTranslateX,
    maxTotalTranslateX,
    minTotalTranslateY,
    maxTotalTranslateY,
  };
}
