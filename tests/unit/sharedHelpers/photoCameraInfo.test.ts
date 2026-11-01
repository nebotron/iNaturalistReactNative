import { formatCameraInfo } from "sharedHelpers/photoCameraInfo";

describe( "formatCameraInfo", ( ) => {
  it( "formats the tags ImageIO reads from a Canon EOS R7 photo", ( ) => {
    expect( formatCameraInfo( {
      Make: "Canon",
      Model: "Canon EOS R7",
      LensModel: "RF200-800mm F6.3-9 IS USM",
      FocalLength: 800,
      FNumber: 9.5,
      ExposureTime: 0.001,
      ISOSpeedRatings: [800],
    } ) ).toEqual( {
      camera: "Canon EOS R7",
      lens: "RF200-800mm F6.3-9 IS USM",
      settings: "800 mm · f/9.5 · 1/1000 s · ISO 800",
    } );
  } );

  it( "prefixes the make when the model leaves it out", ( ) => {
    expect( formatCameraInfo( { Make: "NIKON CORPORATION", Model: "Z 6" } )?.camera )
      .toBe( "NIKON CORPORATION Z 6" );
  } );

  it( "returns null when there is nothing to show", ( ) => {
    expect( formatCameraInfo( { PixelWidth: 100 } ) ).toBeNull( );
    expect( formatCameraInfo( null ) ).toBeNull( );
  } );
} );
