export const JPEG_COMPRESSION_BLOCK_SIZE = 8;

export interface PixelCrop {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export function isPixelCropBlockAligned(
  crop: PixelCrop,
  blockSize = JPEG_COMPRESSION_BLOCK_SIZE,
): boolean {
  return crop.originX % blockSize === 0
    && crop.originY % blockSize === 0
    && crop.width % blockSize === 0
    && crop.height % blockSize === 0;
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

  return {
    originX,
    originY,
    width,
    height,
  };
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
