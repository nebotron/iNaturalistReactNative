import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { defaultSquareCrop } from "sharedHelpers/normalizedCropTypes";

describe( "imageZoomTransformToNormalizedCrop", ( ) => {
  it( "returns the centered square crop at the default zoom level", ( ) => {
    const viewport = 300;
    const cropSize = viewport * 0.91;
    const crop = imageZoomTransformToNormalizedCrop(
      2000,
      1000,
      viewport,
      viewport,
      cropSize,
      {
        scale: 1,
        translateX: 0,
        translateY: 0,
        focalX: 0,
        focalY: 0,
      },
    );

    expect( crop ).toEqual( defaultSquareCrop( 2000, 1000 ) );
  } );

  it( "zooms into the crop region when the image is scaled up", ( ) => {
    const viewport = 300;
    const cropSize = viewport * 0.91;
    const atScale1 = imageZoomTransformToNormalizedCrop(
      2000,
      1000,
      viewport,
      viewport,
      cropSize,
      {
        scale: 1,
        translateX: 0,
        translateY: 0,
        focalX: 0,
        focalY: 0,
      },
    );
    const atScale2 = imageZoomTransformToNormalizedCrop(
      2000,
      1000,
      viewport,
      viewport,
      cropSize,
      {
        scale: 2,
        translateX: 0,
        translateY: 0,
        focalX: 0,
        focalY: 0,
      },
    );

    expect( atScale2.w ).toBeLessThan( atScale1.w );
    expect( atScale2.h ).toBeLessThan( atScale1.h );
  } );
} );
