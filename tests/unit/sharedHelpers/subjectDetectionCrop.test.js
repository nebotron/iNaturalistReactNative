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

  it( "round-trips a subject-focused crop", ( ) => {
    const crop = {
      x: 0.55,
      y: 0.2,
      w: 0.25,
      h: 0.25,
    };
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

    expect( roundTrip.x ).toBeCloseTo( crop.x, 3 );
    expect( roundTrip.y ).toBeCloseTo( crop.y, 3 );
    expect( roundTrip.w ).toBeCloseTo( crop.w, 3 );
    expect( roundTrip.h ).toBeCloseTo( crop.h, 3 );
  } );
} );

describe( "subjectBoundsToNormalizedCrop", ( ) => {
  const imageWidth = 2000;
  const imageHeight = 1000;

  it( "adds padding and makes the crop square in pixels", ( ) => {
    const crop = subjectBoundsToNormalizedCrop(
      {
        x: 0.4,
        y: 0.3,
        width: 0.2,
        height: 0.4,
      },
      imageWidth,
      imageHeight,
    );

    expect( crop.w * imageWidth ).toBeCloseTo( crop.h * imageHeight, 5 );
    expect( crop.x ).toBeGreaterThanOrEqual( 0 );
    expect( crop.y ).toBeGreaterThanOrEqual( 0 );
    expect( crop.x + crop.w ).toBeLessThanOrEqual( 1 );
    expect( crop.y + crop.h ).toBeLessThanOrEqual( 1 );
  } );

  it( "fills the square container for a landscape image", ( ) => {
    const crop = subjectBoundsToNormalizedCrop(
      {
        x: 0.3,
        y: 0.2,
        width: 0.3,
        height: 0.6,
      },
      imageWidth,
      imageHeight,
    );

    // Pixel side must be equal in both axes
    expect( crop.w * imageWidth ).toBeCloseTo( crop.h * imageHeight, 5 );
    // Crop must not exceed image bounds
    expect( crop.w ).toBeLessThanOrEqual( 1 );
    expect( crop.h ).toBeLessThanOrEqual( 1 );
  } );
} );
