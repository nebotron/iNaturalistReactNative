import {
  computeCropMinScale,
  computeCropPanTranslateLimits,
} from "sharedHelpers/cropPanTranslateLimits";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";

describe( "computeCropPanTranslateLimits", ( ) => {
  const imageWidth = 2000;
  const imageHeight = 1000;
  const viewport = 300;
  const cropSize = viewport * 0.91;
  const context = {
    imageWidth,
    imageHeight,
    viewportWidth: viewport,
    viewportHeight: viewport,
    cropSize,
  };

  const totalTranslate = transform => (
    transform.translateX + transform.focalX
  );
  const totalTranslateY = transform => (
    transform.translateY + transform.focalY
  );

  it( "allows panning to each image edge for a landscape photo", ( ) => {
    const crop = defaultSquareCrop( imageWidth, imageHeight );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const limits = computeCropPanTranslateLimits( context, transform );

    const leftEdgeTransform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      {
        x: 0,
        y: crop.y,
        w: crop.w,
        h: crop.h,
      },
    );
    const rightEdgeTransform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      {
        x: 1 - crop.w,
        y: crop.y,
        w: crop.w,
        h: crop.h,
      },
    );

    expect( totalTranslate( leftEdgeTransform ) ).toBeGreaterThanOrEqual(
      limits.minTotalTranslateX - 0.01,
    );
    expect( totalTranslate( leftEdgeTransform ) ).toBeLessThanOrEqual(
      limits.maxTotalTranslateX + 0.01,
    );
    expect( totalTranslate( rightEdgeTransform ) ).toBeGreaterThanOrEqual(
      limits.minTotalTranslateX - 0.01,
    );
    expect( totalTranslate( rightEdgeTransform ) ).toBeLessThanOrEqual(
      limits.maxTotalTranslateX + 0.01,
    );
  } );

  it( "permits wider pan range than the generic zoom viewport limits", ( ) => {
    const crop = defaultSquareCrop( imageWidth, imageHeight );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const limits = computeCropPanTranslateLimits( context, transform );
    const genericHalfRange = ( viewport * ( transform.scale - 1 ) ) / 2;

    expect(
      limits.maxTotalTranslateX - limits.minTotalTranslateX,
    ).toBeGreaterThan( genericHalfRange * 2 );
  } );

  it( "keeps the current transform inside the computed limits", ( ) => {
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
    const limits = computeCropPanTranslateLimits( context, transform );
    const totalX = totalTranslate( transform );
    const totalY = totalTranslateY( transform );

    expect( totalX ).toBeGreaterThanOrEqual( limits.minTotalTranslateX - 0.01 );
    expect( totalX ).toBeLessThanOrEqual( limits.maxTotalTranslateX + 0.01 );
    expect( totalY ).toBeGreaterThanOrEqual( limits.minTotalTranslateY - 0.01 );
    expect( totalY ).toBeLessThanOrEqual( limits.maxTotalTranslateY + 0.01 );
  } );

  it( "includes each edge transform at the corresponding pan limit", ( ) => {
    const crop = defaultSquareCrop( imageWidth, imageHeight );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      crop,
    );
    const limits = computeCropPanTranslateLimits( context, transform );
    const leftEdgeTransform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      {
        x: 0,
        y: crop.y,
        w: crop.w,
        h: crop.h,
      },
    );
    const leftCrop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      viewport,
      viewport,
      cropSize,
      leftEdgeTransform,
    );

    expect( leftCrop.x ).toBeCloseTo( 0, 2 );
    expect( [
      limits.minTotalTranslateX,
      limits.maxTotalTranslateX,
    ] ).toEqual( expect.arrayContaining( [
      expect.closeTo( totalTranslate( leftEdgeTransform ), 1 ),
    ] ) );
  } );

  it( "pins the axis where the crop exceeds the image to the centered position", ( ) => {
    // At scale 1 the crop square is taller than the (shorter) image height but
    // still narrower than the (longer) image width, so the vertical axis is
    // freed and must be pinned centered (total translate 0) while the
    // horizontal axis stays confined.
    const transform = {
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
    };
    const limits = computeCropPanTranslateLimits( context, transform );

    expect( limits.minTotalTranslateY ).toBe( 0 );
    expect( limits.maxTotalTranslateY ).toBe( 0 );
    expect( limits.maxTotalTranslateX ).toBeGreaterThan( limits.minTotalTranslateX );
  } );
} );

describe( "computeCropMinScale", ( ) => {
  it( "floors zoom-out at the scale where the crop spans the longer image edge", ( ) => {
    const context = {
      imageWidth: 2000,
      imageHeight: 1000,
      viewportWidth: 300,
      viewportHeight: 300,
      cropSize: 273,
    };
    // Image contained in the square viewport spans 300 (width) x 150 (height),
    // so the crop square (273) equals the longer edge at scale 273 / 300.
    expect( computeCropMinScale( context ) ).toBeCloseTo( 273 / 300, 5 );
  } );

  it( "returns 0 for a degenerate context", ( ) => {
    expect( computeCropMinScale( {
      imageWidth: 0,
      imageHeight: 1000,
      viewportWidth: 300,
      viewportHeight: 300,
      cropSize: 273,
    } ) ).toBe( 0 );
  } );
} );
