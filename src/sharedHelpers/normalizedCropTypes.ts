export interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  // Exposure multiplier predicted by the subject-detection model's baked-in
  // brightness head, clamped to [0.4, 3.0] in-graph. Only present on crops
  // produced by detectSubjectInImage.
  brightness?: number;
}

const MIN_CROP_FRACTION = 0.05;

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

/**
 * Compute the styles needed to display a crop region centered in a square box,
 * with gray letterboxing on exactly 2 sides (or 0 sides for square crops).
 *
 * Returns a `wrapperStyle` to be applied to an `overflow:hidden` View that is
 * sized to the crop region and centered in the box, and an `imageStyle` to be
 * applied to the image element inside that wrapper so the correct crop region
 * appears at the wrapper's origin.
 *
 * Landscape crop (wider than tall): fills box width, letterboxes top + bottom.
 * Portrait crop (taller than wide):  fills box height, letterboxes left + right.
 * Square crop: fills the box exactly, no letterboxing.
 */
export function computeCropStyles(
  crop: NormalizedCrop,
  boxSize: number,
  imageWidth: number,
  imageHeight: number,
) {
  const cropPixelAspect = ( crop.w * imageWidth ) / ( crop.h * imageHeight );

  let scaledW: number;
  let scaledH: number;
  let horizontalOffset: number;
  let verticalOffset: number;

  if ( cropPixelAspect >= 1 ) {
    // Landscape or square: scale so the crop fills the full box width
    scaledW = boxSize / crop.w;
    scaledH = ( imageHeight / imageWidth ) * scaledW;
    const cropDisplayH = crop.h * scaledH;
    horizontalOffset = 0;
    verticalOffset = cropDisplayH < boxSize
      ? ( boxSize - cropDisplayH ) / 2
      : 0;
  } else {
    // Portrait: scale so the crop fills the full box height
    scaledH = boxSize / crop.h;
    scaledW = ( imageWidth / imageHeight ) * scaledH;
    const cropDisplayW = crop.w * scaledW;
    horizontalOffset = cropDisplayW < boxSize
      ? ( boxSize - cropDisplayW ) / 2
      : 0;
    verticalOffset = 0;
  }

  const cropDisplayW = crop.w * scaledW;
  const cropDisplayH = crop.h * scaledH;

  return {
    // Crop-sized clip container, centered within the box
    wrapperStyle: {
      position: "absolute" as const,
      left: horizontalOffset,
      top: verticalOffset,
      width: cropDisplayW,
      height: cropDisplayH,
      overflow: "hidden" as const,
    },
    // Image positioned so the crop region starts at the wrapper's origin
    imageStyle: {
      position: "absolute" as const,
      left: 0 as const,
      top: 0 as const,
      width: scaledW,
      height: scaledH,
      transform: [
        { translateX: -crop.x * scaledW },
        { translateY: -crop.y * scaledH },
      ],
    },
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

export function square2048Crop(
  imageWidth: number,
  imageHeight: number,
  currentCrop?: NormalizedCrop | null,
): NormalizedCrop {
  if ( imageWidth <= 0 || imageHeight <= 0 ) {
    return {
      x: 0, y: 0, w: 1, h: 1,
    };
  }

  const cropSize = Math.min( 2048, imageWidth, imageHeight );
  const w = cropSize / imageWidth;
  const h = cropSize / imageHeight;

  // Keep the new crop centered on the current crop's center when one is
  // provided, so resizing to 2048 doesn't jump the region back to the middle
  // of the image. clampCrop keeps it inside the image bounds.
  const cx = currentCrop
    ? currentCrop.x + currentCrop.w / 2
    : 0.5;
  const cy = currentCrop
    ? currentCrop.y + currentCrop.h / 2
    : 0.5;

  return clampCrop( {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
  } );
}
