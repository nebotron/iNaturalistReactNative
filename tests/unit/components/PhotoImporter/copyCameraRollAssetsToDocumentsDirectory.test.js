import {
  copyAssetsFileIOS,
  copyFile,
  mkdir,
} from "@dr.pogodin/react-native-fs";
import {
  copyCameraRollAssetsToDocumentsDirectory,
} from "components/PhotoImporter/CustomPhotoLibrary/helpers/copyCameraRollAssetsToDocumentsDirectory";

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  copyAssetsFileIOS: jest.fn( ( _sourceUri, destPath ) => Promise.resolve( destPath ) ),
  copyFile: jest.fn( ( ) => Promise.resolve( ) ),
  mkdir: jest.fn( ( ) => Promise.resolve( ) ),
} ) );

describe( "copyCameraRollAssetsToDocumentsDirectory", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
  } );

  it( "copies assets with unique destination file names", async ( ) => {
    const assets = [
      {
        id: "asset-1",
        uri: "file:///tmp/photo.jpg",
        fileName: "photo.jpg",
        type: "image/jpeg",
      },
      {
        id: "asset-2",
        uri: "file:///tmp/photo.jpg",
        fileName: "photo.jpg",
        type: "image/jpeg",
      },
    ];

    await copyCameraRollAssetsToDocumentsDirectory( assets );

    expect( mkdir ).toHaveBeenCalled( );
    expect( copyFile ).toHaveBeenCalledTimes( 2 );
    expect( copyFile.mock.calls[0][1] ).toContain( "asset-1-photo.jpg" );
    expect( copyFile.mock.calls[1][1] ).toContain( "asset-2-photo.jpg" );
    expect( copyFile.mock.calls[0][1] ).not.toEqual( copyFile.mock.calls[1][1] );
  } );

  it( "limits concurrent copies", async ( ) => {
    let inFlight = 0;
    let maxInFlight = 0;

    copyFile.mockImplementation( async ( ) => {
      inFlight += 1;
      maxInFlight = Math.max( maxInFlight, inFlight );
      await new Promise( resolve => {
        setTimeout( resolve, 20 );
      } );
      inFlight -= 1;
    } );

    const assets = Array.from( { length: 6 }, ( _, index ) => ( {
      id: `asset-${index}`,
      uri: `file:///tmp/photo-${index}.jpg`,
      fileName: `photo-${index}.jpg`,
      type: "image/jpeg",
    } ) );

    await copyCameraRollAssetsToDocumentsDirectory( assets );

    expect( maxInFlight ).toBeLessThanOrEqual( 4 );
    expect( copyAssetsFileIOS ).not.toHaveBeenCalled( );
  } );
} );
