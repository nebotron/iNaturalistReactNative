import {
  cropToImageZoomTransform,
  defaultSquareCrop,
  imageZoomTransformToCrop,
} from "sharedHelpers/cropMath";

describe( "cropToImageZoomTransform round-trip", ( ) => {
  const imageWidth = 2000;
  const imageHeight = 1000;
  const viewport = 300;
  const cropSize = viewport * 0.91;

  it( "round-trips the default centered square crop", ( ) => {
    const crop = defaultSquareCrop( imageWidth, imageHeight );
    const transform = cropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const roundTrip = imageZoomTransformToCrop(
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
    // For a 2000x1000 image in a 300x300 viewport, the contain rect is 300x150.
    // Round-trip fidelity requires: crop.w * 300 = crop.h * 150 → crop.w = crop.h/2.
    const crop = {
      x: 0.4,
      y: 0.1,
      w: 0.125,
      h: 0.25,
    };
    const transform = cropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const roundTrip = imageZoomTransformToCrop(
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
