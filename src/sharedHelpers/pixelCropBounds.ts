interface PixelCrop {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

// Normalized-to-pixel rounding can leave a square selection a pixel off
const SQUARE_TOLERANCE_PX = 2;

const clamp = ( value: number, min: number, max: number ) => (
  Math.max( min, Math.min( value, max ) )
);

// The pixel rect of a normalized crop, inside the image. The crop is passed
// through as selected, with no snapping to JPEG blocks: the native cropper
// re-encodes anyway, and growing a 2048px selection to the next block made it
// larger than the upload size, so the whole crop got resampled on upload.
function pixelCropFromNormalizedCrop(
  crop: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
): PixelCrop {
  if ( imageWidth <= 0 || imageHeight <= 0 ) {
    return {
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
    };
  }

  const originX = clamp( Math.round( crop.x * imageWidth ), 0, imageWidth - 1 );
  const originY = clamp( Math.round( crop.y * imageHeight ), 0, imageHeight - 1 );
  let width = clamp( Math.round( crop.w * imageWidth ), 1, imageWidth - originX );
  let height = clamp( Math.round( crop.h * imageHeight ), 1, imageHeight - originY );

  // A square selection a pixel off would draw letterboxed, with a slim border,
  // in a square cell. Trim to the short side so it never grows past what was
  // selected (or past the upload size).
  if ( Math.abs( width - height ) <= SQUARE_TOLERANCE_PX ) {
    const side = Math.min( width, height );
    width = side;
    height = side;
  }

  return {
    originX,
    originY,
    width,
    height,
  };
}

export default pixelCropFromNormalizedCrop;
