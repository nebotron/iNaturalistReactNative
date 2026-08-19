import {
  clampCrop,
  computeContainRect,
  defaultSquareCrop,
  square2048Crop,
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

describe( "square2048Crop", ( ) => {
  it( "returns full image for images smaller than 2048", ( ) => {
    const crop = square2048Crop( 1000, 1000 );
    expect( crop ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
  } );

  it( "returns centered 2048 crop for large landscape images", ( ) => {
    const crop = square2048Crop( 4000, 3000 );
    expect( crop.w ).toBeCloseTo( 2048 / 4000, 5 );
    expect( crop.h ).toBeCloseTo( 2048 / 3000, 5 );
    expect( crop.x ).toBeCloseTo( ( 1 - 2048 / 4000 ) / 2, 5 );
    expect( crop.y ).toBeCloseTo( ( 1 - 2048 / 3000 ) / 2, 5 );
  } );

  it( "returns centered 2048 crop for large portrait images", ( ) => {
    const crop = square2048Crop( 3000, 4000 );
    expect( crop.w ).toBeCloseTo( 2048 / 3000, 5 );
    expect( crop.h ).toBeCloseTo( 2048 / 4000, 5 );
    expect( crop.x ).toBeCloseTo( ( 1 - 2048 / 3000 ) / 2, 5 );
    expect( crop.y ).toBeCloseTo( ( 1 - 2048 / 4000 ) / 2, 5 );
  } );

  it( "returns full image for square 2048x2048 images", ( ) => {
    const crop = square2048Crop( 2048, 2048 );
    expect( crop ).toEqual( {
      x: 0, y: 0, w: 1, h: 1,
    } );
  } );

  it( "constrains crops to image boundaries", ( ) => {
    const crop = square2048Crop( 4000, 3000 );
    expect( crop.x ).toBeGreaterThanOrEqual( 0 );
    expect( crop.y ).toBeGreaterThanOrEqual( 0 );
    expect( crop.x + crop.w ).toBeLessThanOrEqual( 1 );
    expect( crop.y + crop.h ).toBeLessThanOrEqual( 1 );
  } );

  it( "keeps the new crop centered on the current crop's center", ( ) => {
    const current = {
      x: 0.5, y: 0.5, w: 0.1, h: 0.1,
    };
    const crop = square2048Crop( 4000, 3000, current );
    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;
    expect( crop.x + crop.w / 2 ).toBeCloseTo( cx, 5 );
    expect( crop.y + crop.h / 2 ).toBeCloseTo( cy, 5 );
  } );

  it( "clamps a current-centered crop to image boundaries", ( ) => {
    const current = {
      x: 0.95, y: 0.95, w: 0.05, h: 0.05,
    };
    const crop = square2048Crop( 4000, 3000, current );
    expect( crop.x ).toBeGreaterThanOrEqual( 0 );
    expect( crop.y ).toBeGreaterThanOrEqual( 0 );
    expect( crop.x + crop.w ).toBeLessThanOrEqual( 1 );
    expect( crop.y + crop.h ).toBeLessThanOrEqual( 1 );
  } );
} );
