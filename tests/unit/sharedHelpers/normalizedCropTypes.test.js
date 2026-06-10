import {
  computeContainRect,
  defaultSquareCrop,
} from "sharedHelpers/cropMath";

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

describe( "computeContainRect", ( ) => {
  it( "letterboxes wide images vertically", ( ) => {
    const rect = computeContainRect( 300, 300, 600, 300 );
    expect( rect.width ).toBe( 300 );
    expect( rect.height ).toBe( 150 );
    expect( rect.top ).toBe( 75 );
  } );

  it( "pillarboxes tall images horizontally", ( ) => {
    const rect = computeContainRect( 300, 300, 300, 600 );
    expect( rect.height ).toBe( 300 );
    expect( rect.width ).toBe( 150 );
    expect( rect.left ).toBe( 75 );
  } );
} );
