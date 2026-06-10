export interface NormalizedCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageZoomTransform {
  scale: number;
  translateX: number;
  translateY: number;
  focalX: number;
  focalY: number;
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

function clampCropPosition( crop: NormalizedCrop ): NormalizedCrop {
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

export function cropToImageZoomTransform(
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
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
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

  return {
    scale,
    translateX: -half - scale * ( contain.left + crop.x * contain.width - centerX ),
    translateY: -half - scale * ( contain.top + crop.y * contain.height - centerY ),
    focalX: 0,
    focalY: 0,
  };
}

export function imageZoomTransformToCrop(
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

  return clampCropPosition( {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  } );
}
