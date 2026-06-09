export interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function defaultSquareCrop(
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  if ( imageWidth <= 0 || imageHeight <= 0 ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  const w = Math.min( 1, imageHeight / imageWidth );
  const h = Math.min( 1, imageWidth / imageHeight );

  return {
    x: ( 1 - w ) / 2,
    y: ( 1 - h ) / 2,
    w,
    h,
  };
}

export function clampCropPosition( crop: NormalizedCrop ): NormalizedCrop {
  "worklet";

  if (
    Number.isNaN( crop.x )
    || Number.isNaN( crop.y )
    || Number.isNaN( crop.w )
    || Number.isNaN( crop.h )
  ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  return {
    ...crop,
    x: Math.max( 0, Math.min( 1 - crop.w, crop.x ) ),
    y: Math.max( 0, Math.min( 1 - crop.h, crop.y ) ),
  };
}

export function computeContainRect(
  containerWidth: number,
  containerHeight: number,
  imageWidth: number,
  imageHeight: number,
) {
  "worklet";

  if (
    containerWidth <= 0
    || containerHeight <= 0
    || imageWidth <= 0
    || imageHeight <= 0
  ) {
    return {
      left: 0, top: 0, width: 0, height: 0,
    };
  }

  const imageAspect = imageWidth / imageHeight;
  const containerAspect = containerWidth / containerHeight;

  if ( imageAspect > containerAspect ) {
    const width = containerWidth;
    const height = containerWidth / imageAspect;
    return {
      left: 0,
      top: ( containerHeight - height ) / 2,
      width,
      height,
    };
  }

  const height = containerHeight;
  const width = containerHeight * imageAspect;
  return {
    left: ( containerWidth - width ) / 2,
    top: 0,
    width,
    height,
  };
}
