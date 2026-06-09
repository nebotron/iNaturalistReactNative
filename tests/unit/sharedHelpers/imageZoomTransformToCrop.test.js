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

    expect( crop.x ).toBeCloseTo( 0.045, 3 );
    expect( crop.y ).toBe( 0 );
    expect( crop.w ).toBeCloseTo( 0.91, 3 );
    expect( crop.h ).toBe( 1 );
  } );
} );
