import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform }
  from "sharedHelpers/normalizedCropToImageZoomTransform";

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
