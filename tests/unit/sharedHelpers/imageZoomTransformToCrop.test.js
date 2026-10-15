import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";

describe( "imageZoomTransformToNormalizedCrop", ( ) => {
  it( "returns the crop frame intersection at the default zoom level", ( ) => {
    const viewport = 300;
    const cropSize = viewport * 0.91;
    // Landscape 2000x1000 image: at scale=1, image fits viewport width (300px wide, 150px tall).
    // The 273px square crop frame extends beyond the image top/bottom but is narrower than the
    // image, so the intersection is 273x150 screen pixels → normalized {x:0.045, y:0, w:0.91, h:1}.
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

    expect( crop.x ).toBeCloseTo( 0.045 );
    expect( crop.y ).toBe( 0 );
    expect( crop.w ).toBeCloseTo( 0.91 );
    expect( crop.h ).toBe( 1 );
  } );

  it( "returns the full image when it is entirely inside the crop frame", ( ) => {
    // Square 100x100 image zoomed out to scale=0.3; the entire image fits within the crop frame.
    const viewport = 300;
    const cropSize = viewport * 0.91;
    const crop = imageZoomTransformToNormalizedCrop(
      100,
      100,
      viewport,
      viewport,
      cropSize,
      {
        scale: 0.3,
        translateX: 0,
        translateY: 0,
        focalX: 0,
        focalY: 0,
      },
    );

    expect( crop ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
  } );

  it( "returns the full landscape image when it is entirely inside the crop frame", ( ) => {
    // Landscape 200x100 image zoomed out to scale=0.3; entire image fits within the crop frame.
    // Result should be the full image {x:0,y:0,w:1,h:1}, not a square crop.
    const viewport = 300;
    const cropSize = viewport * 0.91;
    const crop = imageZoomTransformToNormalizedCrop(
      200,
      100,
      viewport,
      viewport,
      cropSize,
      {
        scale: 0.3,
        translateX: 0,
        translateY: 0,
        focalX: 0,
        focalY: 0,
      },
    );

    expect( crop ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
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
