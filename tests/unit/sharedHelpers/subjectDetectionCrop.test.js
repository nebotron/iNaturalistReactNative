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
    // w * imageWidth must equal h * imageHeight for the crop to be square in
    // pixel space (0.125 * 2000 == 0.25 * 1000 == 250), which is required for
    // a perfect round-trip through the square viewport crop box.
    const crop = {
      x: 0.55,
      y: 0.2,
      w: 0.125,
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

  it( "hedges a small subject outward by more than a large one", ( ) => {
    const sideFor = size => {
      const crop = subjectBoundsToNormalizedCrop(
        {
          x: 0.5 - size / 2,
          y: 0.5 - ( size * 2 ) / 2,
          width: size,
          height: size * 2,
        },
        imageWidth,
        imageHeight,
        0,
      );
      // The box is square in pixels (size * 2000 === size * 2 * 1000), so this
      // is how much wider than the subject the crop ends up.
      return ( crop.w * imageWidth ) / ( size * imageWidth );
    };

    const smallGain = sideFor( 0.05 );
    const largeGain = sideFor( 0.4 );

    expect( smallGain ).toBeGreaterThan( 1 );
    expect( largeGain ).toBeGreaterThan( 1 );
    expect( smallGain ).toBeGreaterThan( largeGain );
  } );

  it( "leaves a subject that already fills the frame alone", ( ) => {
    const crop = subjectBoundsToNormalizedCrop(
      {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
      1000,
      1000,
      0,
    );

    expect( crop.w ).toBeCloseTo( 1, 6 );
    expect( crop.h ).toBeCloseTo( 1, 6 );
  } );
} );
