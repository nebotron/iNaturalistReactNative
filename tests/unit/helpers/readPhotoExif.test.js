import * as Exify from "@lodev09/react-native-exify";
import readPhotoExif from "sharedHelpers/readPhotoExif";

describe( "readPhotoExif", ( ) => {
  beforeEach( ( ) => Exify.read.mockReset( ) );

  it( "reads the full EXIF tag set from a local photo file", async ( ) => {
    const tags = {
      Make: "Canon",
      Model: "Canon EOS R7",
      SubjectDistance: 2.5,
      FocalLength: 400,
    };
    Exify.read.mockResolvedValueOnce( tags );

    const result = await readPhotoExif( {
      localFilePath: "/some/dir/photoUploads/abc.jpg",
    } );

    expect( Exify.read ).toHaveBeenCalledWith(
      expect.stringContaining( "abc.jpg" ),
    );
    expect( result ).toEqual( tags );
  } );

  it( "returns null when the photo has no readable uri", async ( ) => {
    const result = await readPhotoExif( {} );
    expect( result ).toBeNull( );
    expect( Exify.read ).not.toHaveBeenCalled( );
  } );

  it( "returns null when EXIF reading fails", async ( ) => {
    Exify.read.mockRejectedValueOnce( new Error( "boom" ) );
    const result = await readPhotoExif( {
      localFilePath: "/some/dir/photoUploads/broken.jpg",
    } );
    expect( result ).toBeNull( );
  } );
} );
