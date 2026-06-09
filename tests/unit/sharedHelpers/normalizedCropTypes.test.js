import {
  clampCrop,
  computeContainRect,
  cropToDisplayRect,
  defaultSquareCrop,
  panCropFromScreenTranslation,
  panSquareCrop,
  pinchCropAtFocalPoint,
  squareCropSidePixels,
  zoomSquareCropFromCenter,
} from "sharedHelpers/normalizedCropTypes";

describe( "defaultSquareCrop", ( ) => {
  it( "returns a centered square for landscape images", ( ) => {
    const crop = defaultSquareCrop( 2000, 1000 );
    expect( crop.w ).toBe( 0.5 );
    expect( crop.h ).toBe( 1 );
    expect( crop.x ).toBe( 0.25 );
    expect( crop.y ).toBe( 0 );
  } );

  it( "returns a centered square for portrait images", ( ) => {
    const crop = defaultSquareCrop( 1000, 2000 );
    expect( crop.w ).toBe( 1 );
    expect( crop.h ).toBe( 0.5 );
    expect( crop.x ).toBe( 0 );
    expect( crop.y ).toBe( 0.25 );
  } );

  it( "returns full image for square images", ( ) => {
    const crop = defaultSquareCrop( 1000, 1000 );
    expect( crop ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
  } );
} );

describe( "clampCrop", ( ) => {
  it( "keeps crop inside image bounds", ( ) => {
    const crop = clampCrop( {
      x: 0.9, y: 0.9, w: 0.2, h: 0.2,
    } );
    expect( crop.x ).toBeLessThanOrEqual( 1 - crop.w );
    expect( crop.y ).toBeLessThanOrEqual( 1 - crop.h );
  } );
} );

describe( "computeContainRect", ( ) => {
  it( "letterboxes wide images vertically", ( ) => {
    const rect = computeContainRect( 300, 300, 600, 300 );
    expect( rect.width ).toBe( 300 );
    expect( rect.height ).toBe( 150 );
    expect( rect.top ).toBe( 75 );
  } );
} );

describe( "cropToDisplayRect", ( ) => {
  it( "maps normalized crop to display coordinates", ( ) => {
    const rect = cropToDisplayRect(
      {
        x: 0.25, y: 0, w: 0.5, h: 1,
      },
      {
        left: 0, top: 50, width: 200, height: 100,
      },
    );
    expect( rect ).toEqual( {
      left: 50,
      top: 50,
      width: 100,
      height: 100,
    } );
  } );
} );

describe( "zoomCropFromCenter", ( ) => {
  it( "zooms in while keeping a square crop", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const zoomed = zoomSquareCropFromCenter( start, 2, 2000, 1000 );
    expect( squareCropSidePixels( zoomed, 2000, 1000 ) )
      .toBeCloseTo( squareCropSidePixels( start, 2000, 1000 ) / 2, 0 );
  } );

  it( "can zoom in past the old minimum crop fraction", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const zoomed = zoomSquareCropFromCenter( start, 200, 2000, 1000 );
    expect( squareCropSidePixels( zoomed, 2000, 1000 ) ).toBe( 5 );
  } );

  it( "can zoom out to the full image", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const zoomed = zoomSquareCropFromCenter( start, 0.5, 2000, 1000 );
    expect( zoomed ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
  } );
} );

describe( "panCropFromScreenTranslation", ( ) => {
  it( "moves the image one screen pixel per finger pixel", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const boxSize = 300;
    const moved = panCropFromScreenTranslation(
      start,
      30,
      0,
      boxSize,
      2000,
      1000,
    );
    expect( moved.x ).toBeCloseTo( start.x - 30 / ( boxSize / start.w ), 5 );
    expect( moved.w ).toBe( start.w );
    expect( moved.h ).toBe( start.h );
  } );
} );

describe( "pinchCropAtFocalPoint", ( ) => {
  it( "keeps the focal point anchored while zooming", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const boxSize = 300;
    const focal = boxSize / 2;
    const zoomed = pinchCropAtFocalPoint(
      start,
      2,
      focal,
      focal,
      focal,
      focal,
      boxSize,
      2000,
      1000,
    );

    const anchorX = start.x + ( focal / boxSize ) * start.w;
    const anchorY = start.y + ( focal / boxSize ) * start.h;
    expect( anchorX ).toBeCloseTo(
      zoomed.x + ( focal / boxSize ) * zoomed.w,
      5,
    );
    expect( anchorY ).toBeCloseTo(
      zoomed.y + ( focal / boxSize ) * zoomed.h,
      5,
    );
  } );

  it( "pans when the focal point moves without scaling", ( ) => {
    const start = defaultSquareCrop( 2000, 1000 );
    const boxSize = 300;
    const moved = pinchCropAtFocalPoint(
      start,
      1,
      boxSize / 2,
      boxSize / 2,
      boxSize / 2 + 30,
      boxSize / 2,
      boxSize,
      2000,
      1000,
    );
    const panned = panCropFromScreenTranslation(
      start,
      30,
      0,
      boxSize,
      2000,
      1000,
    );
    expect( moved ).toEqual( panned );
  } );
} );

describe( "panSquareCrop", ( ) => {
  it( "moves the crop region", ( ) => {
    const crop = {
      x: 0.25, y: 0, w: 0.5, h: 1,
    };
    const moved = panSquareCrop( crop, 0.1, 0 );
    expect( moved.x ).toBe( 0.35 );
  } );
} );
