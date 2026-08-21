import { NativeModules } from "react-native";

const decodeRawToJpeg = jest.fn( );
NativeModules.ImageCropper = { ...NativeModules.ImageCropper, decodeRawToJpeg };

// eslint-disable-next-line global-require
const Photo = require( "realmModels/Photo" ).default;

const RAW = "file:///gallery/3S1A6987.CR3";

// ImageIO cannot demosaic a CR3: it hands back the JPEG preview the camera
// embedded, already rendered and already corrected by the camera. Core Image's
// RAW pipeline is the only way an import ever sees the sensor data.
describe( "resizeImageForUpload with a camera raw", ( ) => {
  beforeEach( ( ) => jest.clearAllMocks( ) );

  it( "decodes the raw rather than resizing the camera's preview", async ( ) => {
    decodeRawToJpeg.mockResolvedValue( {
      decoded: true,
      outputPath: "/photoUploads/3S1A6987.jpg",
      width: 2048,
      height: 1365,
      ms: 900,
    } );

    const result = await Photo.resizeImageForUpload( RAW );

    expect( decodeRawToJpeg ).toHaveBeenCalledWith(
      "/gallery/3S1A6987.CR3",
      2048,
      expect.stringContaining( "3S1A6987.jpg" ),
    );
    expect( result ).toBe( "file:///photoUploads/3S1A6987.jpg" );
  } );

  it( "falls back to the resizer when iOS has no decoder for the file", async ( ) => {
    decodeRawToJpeg.mockResolvedValue( {
      decoded: false,
      reason: "no raw decoder for this file",
    } );

    const result = await Photo.resizeImageForUpload( RAW );

    // Back on the resizer, which names its output after the file it was given.
    expect( result ).toContain( "3S1A6987.CR3" );
  } );

  it( "falls back when the decode throws, rather than failing the import", async ( ) => {
    decodeRawToJpeg.mockRejectedValue( new Error( "out of memory" ) );

    await expect( Photo.resizeImageForUpload( RAW ) ).resolves.toContain(
      "3S1A6987.CR3",
    );
  } );

  it( "leaves an ordinary photo on the resizer", async ( ) => {
    const result = await Photo.resizeImageForUpload( "file:///gallery/IMG_1.jpg" );

    expect( decodeRawToJpeg ).not.toHaveBeenCalled( );
    expect( result ).toContain( "IMG_1.jpg" );
  } );
} );
