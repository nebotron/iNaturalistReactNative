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
      SubjectDistance: 12.345,
    } ) ).toEqual( {
      camera: "Canon EOS R7",
      lens: "RF200-800mm F6.3-9 IS USM",
      focalLength: "800 mm",
      aperture: "f/9.5",
      shutterSpeed: "1/1000 s",
      iso: "800",
      focusDistance: "12.35 m",
    } );
  } );

  it( "lists every other tag for the table", ( ) => {
    expect( formatCameraInfo( {
      Model: "iPhone 15",
      ExposureBiasValue: 0.333333,
      SubjectArea: [2000, 1500, 2200, 1300],
    } )?.metadata ).toEqual( [
      ["ExposureBiasValue", "0.3333"],
      ["SubjectArea", "2000, 1500, 2200, 1300"],
    ] );
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
