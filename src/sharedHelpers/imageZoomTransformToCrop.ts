import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { clampCropPosition, computeContainRect } from "sharedHelpers/normalizedCropTypes";

export interface ImageZoomTransform {
  scale: number;
  translateX: number;
  translateY: number;
  focalX: number;
  focalY: number;
}

export function imageZoomTransformToNormalizedCrop(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  cropSize: number,
  transform: ImageZoomTransform,
): NormalizedCrop {
  "worklet";

  if (
    imageWidth <= 0
    || imageHeight <= 0
    || viewportWidth <= 0
    || viewportHeight <= 0
    || cropSize <= 0
    || transform.scale <= 0
  ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  const contain = computeContainRect(
    viewportWidth,
    viewportHeight,
    imageWidth,
    imageHeight,
  );
  const totalTx = transform.translateX + transform.focalX;
  const totalTy = transform.translateY + transform.focalY;
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  const half = cropSize / 2;

  const toNormalized = ( screenX: number, screenY: number ) => {
    const localX = centerX + ( screenX - centerX - totalTx ) / transform.scale;
    const localY = centerY + ( screenY - centerY - totalTy ) / transform.scale;
    return {
      nx: ( localX - contain.left ) / contain.width,
      ny: ( localY - contain.top ) / contain.height,
    };
  };

  const corners = [
    toNormalized( centerX - half, centerY - half ),
    toNormalized( centerX + half, centerY - half ),
    toNormalized( centerX - half, centerY + half ),
    toNormalized( centerX + half, centerY + half ),
  ];

  const minX = Math.max( 0, Math.min( ...corners.map( p => p.nx ) ) );
  const maxX = Math.min( 1, Math.max( ...corners.map( p => p.nx ) ) );
  const minY = Math.max( 0, Math.min( ...corners.map( p => p.ny ) ) );
  const maxY = Math.min( 1, Math.max( ...corners.map( p => p.ny ) ) );

  const w = maxX - minX;
  const h = maxY - minY;

  return clampCropPosition( {
    x: minX,
    y: minY,
    w,
    h,
  } );
}
