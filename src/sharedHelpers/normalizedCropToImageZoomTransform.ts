import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";

export function normalizedCropToImageZoomTransform(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  cropSize: number,
  crop: NormalizedCrop,
): ImageZoomTransform {
  "worklet";

  if (
    imageWidth <= 0
    || imageHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
    || cropSize <= 0
    || crop.w <= 0
    || crop.h <= 0
  ) {
    return {
      scale: 1,
      translateX: 0,
      translateY: 0,
      focalX: 0,
      focalY: 0,
    };
  }

  const contain = computeContainRect(
    viewportWidth,
    viewportHeight,
    imageWidth,
    imageHeight,
  );
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  const half = cropSize / 2;

  const scaleFromWidth = cropSize / ( crop.w * contain.width );
  const scaleFromHeight = cropSize / ( crop.h * contain.height );
  const scale = Math.min( scaleFromWidth, scaleFromHeight );

  const totalTranslateX = -half
    - scale * ( contain.left + crop.x * contain.width - centerX );
  const totalTranslateY = -half
    - scale * ( contain.top + crop.y * contain.height - centerY );

  return {
    scale,
    translateX: totalTranslateX,
    translateY: totalTranslateY,
    focalX: 0,
    focalY: 0,
  };
}

export default normalizedCropToImageZoomTransform;
