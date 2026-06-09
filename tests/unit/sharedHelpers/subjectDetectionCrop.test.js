import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform } from "sharedHelpers/normalizedCropToImageZoomTransform";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";

describe( "normalizedCropToImageZoomTransform round-trip", ( ) => {
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

  it( "round-trips a subject-focused crop (display-square region)", ( ) => {
    // For a 2000x1000 image displayed in 300x300 viewport, the contain rect is
    // 300x150. For round-trip fidelity both axes must be equally constraining,
    // so the crop must satisfy: crop.w * 300 = crop.h * 150, i.e. crop.w = crop.h/2.
    const crop = {
      x: 0.4,
      y: 0.1,
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
