import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";
import { subjectBoundsToNormalizedCrop } from "sharedHelpers/subjectBoundsToNormalizedCrop";

describe( "normalizedCropToImageZoomTransform", ( ) => {
  const imageWidth = 2000;
  const imageHeight = 1000;
  const viewport = 300;
  const cropSize = viewport * 0.91;

  it( "round-trips the default centered square crop", ( ) => {
    const crop = defaultSquareCrop( imageWidth, imageHeight );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const roundTrip = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      transform,
    );

    expect( roundTrip.x ).toBeCloseTo( crop.x, 4 );
    expect( roundTrip.y ).toBeCloseTo( crop.y, 4 );
    expect( roundTrip.w ).toBeCloseTo( crop.w, 4 );
    expect( roundTrip.h ).toBeCloseTo( crop.h, 4 );
  } );
} );

describe( "subjectBoundsToNormalizedCrop", ( ) => {
  it( "adds padding and makes the crop square", ( ) => {
    const crop = subjectBoundsToNormalizedCrop( {
      x: 0.4,
      y: 0.3,
      width: 0.2,
      height: 0.4,
    } );

    expect( crop.w ).toBe( crop.h );
    expect( crop.x ).toBeGreaterThanOrEqual( 0 );
    expect( crop.y ).toBeGreaterThanOrEqual( 0 );
    expect( crop.x + crop.w ).toBeLessThanOrEqual( 1 );
    expect( crop.y + crop.h ).toBeLessThanOrEqual( 1 );
  } );
} );
