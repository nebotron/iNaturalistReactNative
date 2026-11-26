import { stat } from "@dr.pogodin/react-native-fs";
import { Image, NativeModules } from "react-native";

const resizeForUpload = jest.fn( );
NativeModules.ImageCropper = { ...NativeModules.ImageCropper, resizeForUpload };

// eslint-disable-next-line global-require
const Photo = require( "realmModels/Photo" ).default;

describe( "resizeImageForUpload on iOS", ( ) => {
  beforeEach( ( ) => jest.clearAllMocks( ) );

  it( "writes the upload copy natively at the upload size", async ( ) => {
    resizeForUpload.mockImplementation( async ( _input, _max, output ) => ( {
      path: output, reencoded: true, width: 2048, height: 1536,
    } ) );

    const result = await Photo.resizeImageForUpload( "file:///galleryPhotos/IMG_1.HEIC" );

    expect( resizeForUpload ).toHaveBeenCalledWith(
      "/galleryPhotos/IMG_1.HEIC",
      2048,
      expect.stringMatching( /photoUploads\/.+\.jpg$/ ),
    );
    expect( result ).toMatch( /^file:\/\/.*photoUploads\/.+\.jpg$/ );
  } );

  it( "gives a crop its own copy rather than sharing the crop's file", async ( ) => {
    resizeForUpload.mockImplementation( async ( _input, _max, output ) => ( {
      path: output, reencoded: false, width: 2048, height: 2048,
    } ) );

    const crop = "file:///photoUploads/crop.jpg";
    const result = await Photo.resizeImageForUpload( crop );

    expect( resizeForUpload.mock.calls[0][0] ).toBe( "/photoUploads/crop.jpg" );
    expect( result ).not.toBe( crop );
  } );

  it( "falls back to the resizer when the native resize fails", async ( ) => {
    resizeForUpload.mockRejectedValue( new Error( "RESIZE_FAILED" ) );

    const result = await Photo.resizeImageForUpload( "file:///galleryPhotos/IMG_2.jpg" );

    // The resizer mock names its output after the file it was given.
    expect( result ).toContain( "IMG_2.jpg" );
  } );
} );

describe( "ensureUploadableLocalFile", ( ) => {
  const localFilePath = "file:///tmp/photoUploads/detailed.jpg";

  beforeEach( ( ) => jest.clearAllMocks( ) );

  it( "doesn't re-encode a large file that is already at the upload size", async ( ) => {
    stat.mockResolvedValueOnce( { size: 7 * 1024 * 1024 } );
    jest.spyOn( Image, "getSize" ).mockResolvedValueOnce( { width: 2048, height: 1536 } );

    expect( await Photo.ensureUploadableLocalFile( localFilePath ) ).toBe(
      Photo.getLocalPhotoUri( localFilePath ),
    );
  } );

  it( "re-resizes an oversized original", async ( ) => {
    stat.mockResolvedValueOnce( { size: 20 * 1024 * 1024 } );
    jest.spyOn( Image, "getSize" ).mockResolvedValueOnce( { width: 6000, height: 4000 } );
    resizeForUpload.mockRejectedValueOnce( new Error( "unused" ) );

    const uri = await Photo.ensureUploadableLocalFile( localFilePath );

    // The resizer mock echoes the source filename back from its output path.
    expect( uri ).toContain( "detailed.jpg" );
    expect( uri ).not.toBe( Photo.getLocalPhotoUri( localFilePath ) );
  } );
} );
