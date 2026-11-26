import exifUri from "sharedHelpers/exifUri";

describe( "exifUri", ( ) => {
  it( "should add a file scheme to a bare path", ( ) => {
    expect( exifUri( "/photos/IMG_0001.jpg" ) ).toEqual( "file:///photos/IMG_0001.jpg" );
  } );

  it( "should percent-encode spaces, which NSURL rejects", ( ) => {
    expect( exifUri( "file:///photos/Screen Shot 1.png" ) )
      .toEqual( "file:///photos/Screen%20Shot%201.png" );
  } );

  it( "should percent-encode non-ascii filenames", ( ) => {
    expect( exifUri( "/photos/Grünfink.jpg" ) )
      .toEqual( "file:///photos/Gr%C3%BCnfink.jpg" );
  } );

  it( "should keep path separators intact", ( ) => {
    expect( exifUri( "/a b/c d/e f.jpg" ) ).toEqual( "file:///a%20b/c%20d/e%20f.jpg" );
  } );

  it( "should leave other schemes alone", ( ) => {
    expect( exifUri( "ph://ABC-123/L0/001" ) ).toEqual( "ph://ABC-123/L0/001" );
    expect( exifUri( "content://media/external/images/1" ) )
      .toEqual( "content://media/external/images/1" );
  } );
} );
