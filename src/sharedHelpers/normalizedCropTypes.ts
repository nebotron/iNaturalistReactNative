export interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_CROP_FRACTION = 0.05;

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

export function clampCrop(
  crop: NormalizedCrop,
  minFraction = MIN_CROP_FRACTION,
): NormalizedCrop {
  const w = Math.max( minFraction, Math.min( 1, crop.w ) );
  const h = Math.max( minFraction, Math.min( 1, crop.h ) );
  const x = Math.max( 0, Math.min( 1 - w, crop.x ) );
  const y = Math.max( 0, Math.min( 1 - h, crop.y ) );

  if (
    Number.isNaN( x )
    || Number.isNaN( y )
    || Number.isNaN( w )
    || Number.isNaN( h )
  ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  return {
    x, y, w, h,
  };
}

export function squareCropSidePixels(
  crop: NormalizedCrop,
  imageWidth: number,
  imageHeight: number,
): number {
  return Math.min( crop.w * imageWidth, crop.h * imageHeight );
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

  const x = Math.max( 0, Math.min( 1 - crop.w, crop.x ) );
  const y = Math.max( 0, Math.min( 1 - crop.h, crop.y ) );

  return {
    ...crop,
    x,
    y,
  };
}

export function cropScaledDimensions(
  crop: NormalizedCrop,
  boxSize: number,
  imageWidth: number,
  imageHeight: number,
) {
  const scaledW = boxSize / crop.w;
  const scaledH = ( imageHeight / imageWidth ) * scaledW;

  return { scaledW, scaledH };
}

export function panCropFromScreenTranslation(
  startCrop: NormalizedCrop,
  translationX: number,
  translationY: number,
  boxSize: number,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const { scaledW, scaledH } = cropScaledDimensions(
    startCrop,
    boxSize,
    imageWidth,
    imageHeight,
  );

  return clampCropPosition( {
    ...startCrop,
    x: startCrop.x - translationX / scaledW,
    y: startCrop.y - translationY / scaledH,
  } );
}

export function pinchCropAtFocalPoint(
  startCrop: NormalizedCrop,
  scale: number,
  startFocalInFrameX: number,
  startFocalInFrameY: number,
  currentFocalInFrameX: number,
  currentFocalInFrameY: number,
  boxSize: number,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const safeScale = Math.max( scale, 0.01 );
  const minW = 1 / imageWidth;
  const minH = 1 / imageHeight;
  const newW = Math.max( minW, Math.min( 1, startCrop.w / safeScale ) );
  const newH = Math.max( minH, Math.min( 1, startCrop.h / safeScale ) );

  const anchorX = startCrop.x
    + ( startFocalInFrameX / boxSize ) * startCrop.w;
  const anchorY = startCrop.y
    + ( startFocalInFrameY / boxSize ) * startCrop.h;

  return clampCropPosition( {
    x: anchorX - ( currentFocalInFrameX / boxSize ) * newW,
    y: anchorY - ( currentFocalInFrameY / boxSize ) * newH,
    w: newW,
    h: newH,
  } );
}

export function zoomCropFromCenter(
  crop: NormalizedCrop,
  pinchScale: number,
  imageWidth: number,
  imageHeight: number,
): NormalizedCrop {
  const safeScale = Math.max( pinchScale, 0.01 );
  const minW = 1 / imageWidth;
  const minH = 1 / imageHeight;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const newW = Math.max( minW, Math.min( 1, crop.w / safeScale ) );
  const newH = Math.max( minH, Math.min( 1, crop.h / safeScale ) );

  return clampCropPosition( {
    x: cx - newW / 2,
    y: cy - newH / 2,
    w: newW,
    h: newH,
  } );
}

/** @deprecated Use zoomCropFromCenter */
export const zoomSquareCropFromCenter = zoomCropFromCenter;

export function panSquareCrop(
  crop: NormalizedCrop,
  deltaX: number,
  deltaY: number,
): NormalizedCrop {
  return clampCropPosition( {
    ...crop,
    x: crop.x + deltaX,
    y: crop.y + deltaY,
  } );
}

export function cropImageStyle(
  crop: NormalizedCrop,
  boxSize: number,
  imageWidth: number,
  imageHeight: number,
) {
  const scaledW = boxSize / crop.w;
  const scaledH = ( imageHeight / imageWidth ) * scaledW;

  return {
    position: "absolute" as const,
    left: 0,
    top: 0,
    width: scaledW,
    height: scaledH,
    transform: [
      { translateX: -crop.x * scaledW },
      { translateY: -crop.y * scaledH },
    ],
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

export function cropToDisplayRect(
  crop: NormalizedCrop,
  imageRect: { left: number; top: number; width: number; height: number },
) {
  return {
    left: imageRect.left + crop.x * imageRect.width,
    top: imageRect.top + crop.y * imageRect.height,
    width: crop.w * imageRect.width,
    height: crop.h * imageRect.height,
  };
}

export function displayDeltaToNormalized(
  dx: number,
  dy: number,
  imageRect: { width: number; height: number },
) {
  if ( imageRect.width <= 0 || imageRect.height <= 0 ) {
    return { dx: 0, dy: 0 };
  }

  return {
    dx: dx / imageRect.width,
    dy: dy / imageRect.height,
  };
}
