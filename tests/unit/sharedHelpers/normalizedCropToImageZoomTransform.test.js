import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform }
  from "sharedHelpers/normalizedCropToImageZoomTransform";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";

const VIEWPORT = 300;
const CROP_SIZE = VIEWPORT * 0.91;

function roundTrip( imageWidth, imageHeight, crop ) {
  const transform = normalizedCropToImageZoomTransform(
    imageWidth,
    imageHeight,
    VIEWPORT,
    VIEWPORT,
    CROP_SIZE,
    crop,
  );
  return imageZoomTransformToNormalizedCrop(
    imageWidth,
    imageHeight,
    VIEWPORT,
    VIEWPORT,
    CROP_SIZE,
    transform,
  );
}

describe( "normalizedCropToImageZoomTransform round-trip", ( ) => {
  it( "round-trips a centered square crop on a square image", ( ) => {
    const crop = {
      x: 0.25, y: 0.25, w: 0.5, h: 0.5,
    };
    const result = roundTrip( 1000, 1000, crop );
    expect( result.x ).toBeCloseTo( crop.x );
    expect( result.y ).toBeCloseTo( crop.y );
    expect( result.w ).toBeCloseTo( crop.w );
    expect( result.h ).toBeCloseTo( crop.h );
  } );

  it( "round-trips a centered square crop on a landscape image", ( ) => {
    // For a 2:1 image, the square crop occupies {x:0.25, y:0, w:0.5, h:1}
    const crop = {
      x: 0.25, y: 0, w: 0.5, h: 1,
    };
    const result = roundTrip( 2000, 1000, crop );
    expect( result.x ).toBeCloseTo( crop.x );
    expect( result.y ).toBeCloseTo( crop.y );
    expect( result.w ).toBeCloseTo( crop.w );
    expect( result.h ).toBeCloseTo( crop.h );
  } );

  it( "round-trips a full-image crop on a landscape image", ( ) => {
    // When the crop frame is larger than the image, result is the entire image (non-square).
    const crop = {
      x: 0, y: 0, w: 1, h: 1,
    };
    const result = roundTrip( 200, 100, crop );
    expect( result.x ).toBeCloseTo( 0 );
    expect( result.y ).toBeCloseTo( 0 );
    expect( result.w ).toBeCloseTo( 1 );
    expect( result.h ).toBeCloseTo( 1 );
  } );

  it( "round-trips a full-image crop on a portrait image", ( ) => {
    const crop = {
      x: 0, y: 0, w: 1, h: 1,
    };
    const result = roundTrip( 100, 200, crop );
    expect( result.x ).toBeCloseTo( 0 );
    expect( result.y ).toBeCloseTo( 0 );
    expect( result.w ).toBeCloseTo( 1 );
    expect( result.h ).toBeCloseTo( 1 );
  } );
} );

// A Group Photos cell paints an opaque black backdrop behind its photo, so a
// framing that pushes the photo off the cell doesn't show an empty cell -- it
// shows a plain black square. The framing is derived from where the photo lands
// inside the cell, which follows from its aspect ratio, so framing against one
// ratio and drawing a file with another translates the photo off by the
// difference. Group Photos hit exactly that: tile-sized thumbnails came back
// square-cropped, and the cell measured one of those to frame a photo it would
// then draw at its real shape.
describe( "framing a photo drawn at a different aspect ratio", ( ) => {
  const CELL = 120;

  // Fraction of the cell the photo still covers after the cell frames itself
  // against `framed` dimensions and then draws a `real` file. The photo is laid
  // out to fill the cell with resizeMode contain, so its content rect is the
  // contain rect of the real dimensions; the zoom layer scales that about the
  // cell's centre and translates it.
  function coveredFraction( framedWidth, framedHeight, realWidth, realHeight, crop ) {
    const transform = normalizedCropToImageZoomTransform(
      framedWidth,
      framedHeight,
      CELL,
      CELL,
      CELL,
      crop,
    );
    const limits = computeCropPanTranslateLimits( {
      imageWidth: framedWidth,
      imageHeight: framedHeight,
      viewportWidth: CELL,
      viewportHeight: CELL,
      cropSize: CELL,
    }, transform );
    const clamp = ( v, lo, hi ) => Math.min( Math.max( v, lo ), hi );
    const x = clamp( transform.translateX, limits.minTotalTranslateX, limits.maxTotalTranslateX );
    const y = clamp( transform.translateY, limits.minTotalTranslateY, limits.maxTotalTranslateY );
    const contain = computeContainRect( CELL, CELL, realWidth, realHeight );
    const left = CELL / 2 + ( contain.left - CELL / 2 ) * transform.scale + x;
    const top = CELL / 2 + ( contain.top - CELL / 2 ) * transform.scale + y;
    const right = left + contain.width * transform.scale;
    const bottom = top + contain.height * transform.scale;
    const overlapX = Math.max( 0, Math.min( right, CELL ) - Math.max( left, 0 ) );
    const overlapY = Math.max( 0, Math.min( bottom, CELL ) - Math.max( top, 0 ) );
    return ( overlapX * overlapY ) / ( CELL * CELL );
  }

  // Why the black cells were never every cell: the error is the framing offset
  // multiplied by the zoom, and it cancels for a subject on the frame's
  // horizontal midline. A big or centred subject stays on the cell, so photos
  // at one resolution off one camera divide into cells that look right and
  // cells that are solid black, purely by where their subject sits.
  it( "keeps a centred subject on the cell even when framed at the wrong ratio", ( ) => {
    const crop = {
      x: 0.4, y: 0.35, w: 0.2, h: 0.3,
    };
    expect( coveredFraction( 1000, 1000, 6000, 4000, crop ) ).toBeCloseTo( 1 );
  } );

  it( "pushes a tight subject near the top edge entirely off the cell", ( ) => {
    const crop = {
      x: 0.49, y: 0.02, w: 0.02, h: 0.03,
    };
    expect( coveredFraction( 1000, 1000, 6000, 4000, crop ) ).toEqual( 0 );
  } );

  it( "pushes a tight subject near the bottom edge entirely off the cell", ( ) => {
    const crop = {
      x: 0.49, y: 0.95, w: 0.02, h: 0.03,
    };
    expect( coveredFraction( 1000, 1000, 6000, 4000, crop ) ).toEqual( 0 );
  } );

  // Framing against the file that is actually drawn is what the cell now does,
  // and it holds the photo over the cell everywhere the broken framing didn't.
  it( "covers the cell for every subject once framed against the drawn file", ( ) => {
    const cases = [
      {
        crop: {
          x: 0.49, y: 0.02, w: 0.02, h: 0.03,
        },
        dims: [6000, 4000],
      },
      {
        crop: {
          x: 0.49, y: 0.95, w: 0.02, h: 0.03,
        },
        dims: [6000, 4000],
      },
      {
        crop: {
          x: 0, y: 0, w: 0.05, h: 0.075,
        },
        dims: [6000, 4000],
      },
      {
        crop: {
          x: 0.95, y: 0.9, w: 0.05, h: 0.075,
        },
        dims: [4000, 6000],
      },
      {
        crop: {
          x: 0.4, y: 0.35, w: 0.2, h: 0.3,
        },
        dims: [4032, 3024],
      },
    ];
    cases.forEach( ( { crop, dims } ) => {
      const [width, height] = dims;
      expect( coveredFraction( width, height, width, height, crop ) ).toBeCloseTo( 1 );
    } );
  } );
} );
