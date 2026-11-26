import photoUriForPixelSize from "sharedHelpers/photoUriForPixelSize";

const ORIGINAL = "https://inaturalist-open-data.s3.amazonaws.com/photos/1/original.jpeg";

describe( "photoUriForPixelSize", ( ) => {
  it( "picks medium for a small tile", ( ) => {
    expect( photoUriForPixelSize( ORIGINAL, 186 ) )
      .toBe( "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpeg" );
  } );

  it( "picks large for a two-column phone tile", ( ) => {
    expect( photoUriForPixelSize( ORIGINAL, 516 ) )
      .toBe( "https://inaturalist-open-data.s3.amazonaws.com/photos/1/large.jpeg" );
  } );

  it( "keeps the original for a tile bigger than large", ( ) => {
    expect( photoUriForPixelSize( ORIGINAL, 1170 ) ).toBe( ORIGINAL );
  } );

  it( "leaves local files and other sizes alone", ( ) => {
    expect( photoUriForPixelSize( "file:///photos/original.jpg", 100 ) )
      .toBe( "file:///photos/original.jpg" );
    const large = "https://static.inaturalist.org/photos/1/large.jpg";
    expect( photoUriForPixelSize( large, 100 ) ).toBe( large );
  } );
} );
