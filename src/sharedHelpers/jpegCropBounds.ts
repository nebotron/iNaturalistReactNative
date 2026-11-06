export const JPEG_COMPRESSION_BLOCK_SIZE = 8;

interface PixelCrop {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

// Normalized-to-pixel rounding can leave a square selection a pixel off
const SQUARE_TOLERANCE_PX = 2;

const isSquareSelection = ( crop: PixelCrop ) => (
  Math.abs( crop.width - crop.height ) <= SQUARE_TOLERANCE_PX
);

// Grows the short side to match the long one, staying inside the image, and
// trims the long side instead when the image has no room left to grow into.
function squarePixelCrop(
  crop: PixelCrop,
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  const side = Math.min( Math.max( crop.width, crop.height ), imageWidth, imageHeight );
  const fit = ( origin: number, length: number, imageLength: number ) => {
    if ( length > side ) {
      return { origin, length: side };
    }
    return {
      origin: Math.max( 0, Math.min( origin, imageLength - side ) ),
      length: side,
    };
  };
  const x = fit( crop.originX, crop.width, imageWidth );
  const y = fit( crop.originY, crop.height, imageHeight );
  return {
    originX: x.origin,
    originY: y.origin,
    width: x.length,
    height: y.length,
  };
}

export function alignPixelCropOutwardToJpegBlocks(
  crop: PixelCrop,
  imageWidth: number,
  imageHeight: number,
  blockSize = JPEG_COMPRESSION_BLOCK_SIZE,
): PixelCrop {
  if ( imageWidth <= 0 || imageHeight <= 0 ) {
    return {
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
    };
  }

  const selectionRight = crop.originX + crop.width;
  const selectionBottom = crop.originY + crop.height;

  let originX = Math.floor( crop.originX / blockSize ) * blockSize;
  let originY = Math.floor( crop.originY / blockSize ) * blockSize;
  let right = Math.ceil( selectionRight / blockSize ) * blockSize;
  let bottom = Math.ceil( selectionBottom / blockSize ) * blockSize;

  originX = Math.max( 0, originX );
  originY = Math.max( 0, originY );
  right = Math.min( imageWidth, right );
  bottom = Math.min( imageHeight, bottom );

  let width = Math.max( blockSize, right - originX );
  let height = Math.max( blockSize, bottom - originY );

  if ( originX + width > imageWidth ) {
    width = Math.floor( ( imageWidth - originX ) / blockSize ) * blockSize;
  }
  if ( originY + height > imageHeight ) {
    height = Math.floor( ( imageHeight - originY ) / blockSize ) * blockSize;
  }

  width = Math.max( 1, Math.min( width, imageWidth - originX ) );
  height = Math.max( 1, Math.min( height, imageHeight - originY ) );

  const aligned = {
    originX,
    originY,
    width,
    height,
  };
  // Each edge snaps outward on its own, so a square selection could come out
  // a block taller than it is wide (or be clipped unevenly at the image edge)
  // and then draw letterboxed, with slim borders, in a square cell.
  return isSquareSelection( crop )
    ? squarePixelCrop( aligned, imageWidth, imageHeight )
    : aligned;
}

export function pixelCropFromNormalizedCrop(
  crop: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  const originX = Math.round( crop.x * imageWidth );
  const originY = Math.round( crop.y * imageHeight );
  const width = Math.max( 1, Math.round( crop.w * imageWidth ) );
  const height = Math.max( 1, Math.round( crop.h * imageHeight ) );

  return {
    originX,
    originY,
    width,
    height,
  };
}
