import {
  imageZoomTransformToNormalizedCrop,
  imageZoomTransformToNormalizedRect,
} from "sharedHelpers/imageZoomTransformToCrop";

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

describe( "imageZoomTransformToNormalizedRect", ( ) => {
  const identity = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    focalX: 0,
    focalY: 0,
  };

  it( "returns the whole image when it is fully visible in the viewport", ( ) => {
    const crop = imageZoomTransformToNormalizedRect( 3000, 4000, 400, 600, 400, 600, identity );
    expect( crop.x ).toBeCloseTo( 0 );
    expect( crop.y ).toBeCloseTo( 0 );
    expect( crop.w ).toBeCloseTo( 1 );
    expect( crop.h ).toBeCloseTo( 1 );
  } );

  it( "returns the visible rectangle when zoomed and panned", ( ) => {
    // A 400x400 image fills a 400x400 viewport; at 2x the centre quarter is
    // visible, and panning 100 screen px left reveals 50 image px more right.
    const crop = imageZoomTransformToNormalizedRect( 1000, 1000, 400, 400, 400, 400, {
      ...identity,
      scale: 2,
      translateX: -100,
    } );
    expect( crop.x ).toBeCloseTo( 0.375 );
    expect( crop.y ).toBeCloseTo( 0.25 );
    expect( crop.w ).toBeCloseTo( 0.5 );
    expect( crop.h ).toBeCloseTo( 0.5 );
  } );

  it( "keeps the viewport aspect ratio for a non-square viewport", ( ) => {
    // Square image in a 400x800 viewport is 400x400 at scale 1; at 4x the
    // visible 400x800 window covers 1/4 of the width and all of the height.
    const crop = imageZoomTransformToNormalizedRect( 1000, 1000, 400, 800, 400, 800, {
      ...identity,
      scale: 4,
    } );
    expect( crop.x ).toBeCloseTo( 0.375 );
    expect( crop.w ).toBeCloseTo( 0.25 );
    expect( crop.y ).toBeCloseTo( 0.25 );
    expect( crop.h ).toBeCloseTo( 0.5 );
  } );
} );
