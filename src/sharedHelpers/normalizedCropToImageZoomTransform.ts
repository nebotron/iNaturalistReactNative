/* eslint-disable import/prefer-default-export */
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

  const sidePixels = Math.min( crop.w * imageWidth, crop.h * imageHeight );
  const normalizedSideW = sidePixels / imageWidth;
  const normalizedSideH = sidePixels / imageHeight;
  const cropCenterX = crop.x + crop.w / 2;
  const cropCenterY = crop.y + crop.h / 2;

  const scaleFromWidth = cropSize / ( normalizedSideW * contain.width );
  const scaleFromHeight = cropSize / ( normalizedSideH * contain.height );
  const scale = Math.max( scaleFromWidth, scaleFromHeight );

  const totalTranslateX = -half
    - scale * ( contain.left + ( cropCenterX - normalizedSideW / 2 ) * contain.width - centerX );
  const totalTranslateY = -half
    - scale * ( contain.top + ( cropCenterY - normalizedSideH / 2 ) * contain.height - centerY );

  return {
    scale,
    translateX: totalTranslateX,
    translateY: totalTranslateY,
    focalX: 0,
    focalY: 0,
  };
}
