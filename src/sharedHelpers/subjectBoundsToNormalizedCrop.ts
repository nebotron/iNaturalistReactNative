import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { clampCrop } from "sharedHelpers/normalizedCropTypes";

export interface NormalizedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_PADDING_FRACTION = 0.12;

export function subjectBoundsToNormalizedCrop(
  bounds: NormalizedBounds,
  paddingFraction = DEFAULT_PADDING_FRACTION,
): NormalizedCrop {
  if (
    bounds.width <= 0
    || bounds.height <= 0
    || Number.isNaN( bounds.x )
    || Number.isNaN( bounds.y )
  ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  const padW = bounds.width * paddingFraction;
  const padH = bounds.height * paddingFraction;
  let x = bounds.x - padW / 2;
  let y = bounds.y - padH / 2;
  let w = bounds.width + padW;
  let h = bounds.height + padH;

  const side = Math.max( w, h );
  const centerX = x + w / 2;
  const centerY = y + h / 2;
  x = centerX - side / 2;
  y = centerY - side / 2;
  w = side;
  h = side;

  return clampCrop( { x, y, w, h } );
}
