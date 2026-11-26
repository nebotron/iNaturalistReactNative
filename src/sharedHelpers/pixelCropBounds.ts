interface PixelCrop {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

// Normalized-to-pixel rounding can leave a square selection a pixel off
const SQUARE_TOLERANCE_PX = 2;
// A side this close to the snap size (the upload size) is set to exactly it.
// Zoom math drifts a few pixels either way of the slider tick, and a crop even
// one pixel over the upload size is resampled -- softened -- on upload.
export const SNAP_SIDE_TOLERANCE_PX = 8;

const clamp = ( value: number, min: number, max: number ) => (
  Math.max( min, Math.min( value, max ) )
);

// Sets a side within SNAP_SIDE_TOLERANCE_PX of target to exactly target,
// moving the origin back if that would run past the image edge.
const snapSide = (
  origin: number,
  length: number,
  imageLength: number,
  target: number | undefined,
) => {
  if (
    !target
    || target > imageLength
    || Math.abs( length - target ) > SNAP_SIDE_TOLERANCE_PX
  ) {
    return { origin, length };
  }
  return { origin: Math.min( origin, imageLength - target ), length: target };
};

// The pixel rect of a normalized crop, inside the image. The crop is passed
// through as selected, with no snapping to JPEG blocks: the native cropper
// re-encodes anyway, and growing a selection to the next block could make it
// larger than the upload size, so the whole crop got resampled on upload.
// A side within a few pixels of snapSidePx (pass the upload size) is set to
// exactly that.
function pixelCropFromNormalizedCrop(
  crop: { x: number; y: number; w: number; h: number },
  imageWidth: number,
  imageHeight: number,
  snapSidePx?: number,
): PixelCrop {
  if ( imageWidth <= 0 || imageHeight <= 0 ) {
    return {
      originX: 0,
      originY: 0,
      width: 0,
      height: 0,
    };
  }

  let originX = clamp( Math.round( crop.x * imageWidth ), 0, imageWidth - 1 );
  let originY = clamp( Math.round( crop.y * imageHeight ), 0, imageHeight - 1 );
  let width = clamp( Math.round( crop.w * imageWidth ), 1, imageWidth - originX );
  let height = clamp( Math.round( crop.h * imageHeight ), 1, imageHeight - originY );

  ( { origin: originX, length: width } = snapSide( originX, width, imageWidth, snapSidePx ) );
  ( { origin: originY, length: height } = snapSide( originY, height, imageHeight, snapSidePx ) );

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
