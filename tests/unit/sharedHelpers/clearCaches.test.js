import { readDir } from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath, photoUploadPath } from "appConstants/paths";
import { clearGalleryPhotos, clearSyncedMediaForUpload } from "sharedHelpers/clearCaches";
import { unlink } from "sharedHelpers/util";
import useStore from "stores/useStore";

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  DocumentDirectoryPath: "/documents",
  exists: jest.fn( ( ) => Promise.resolve( true ) ),
  readDir: jest.fn( ( ) => Promise.resolve( [] ) ),
  stat: jest.fn( ( ) => Promise.resolve( { size: 1, mtime: 0 } ) ),
} ) );

jest.mock( "sharedHelpers/util", ( ) => ( {
  unlink: jest.fn( ( ) => Promise.resolve( ) ),
} ) );

const dirFile = name => ( {
  name,
  path: `${photoLibraryPhotosPath}/${name}`,
} );

describe( "clearGalleryPhotos", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useStore.setState( { groupedPhotos: [] } );
  } );

  it( "deletes all gallery files when there is no Group Photos progress", async ( ) => {
    readDir.mockResolvedValueOnce( [dirFile( "a.jpg" ), dirFile( "b.jpg" )] );

    await clearGalleryPhotos( );

    expect( unlink ).toHaveBeenCalledTimes( 2 );
    expect( unlink ).toHaveBeenCalledWith( `${photoLibraryPhotosPath}/a.jpg` );
    expect( unlink ).toHaveBeenCalledWith( `${photoLibraryPhotosPath}/b.jpg` );
  } );

  it( "preserves files still referenced by in-progress groupedPhotos", async ( ) => {
    useStore.setState( {
      groupedPhotos: [
        { photos: [{ image: { uri: `file://${photoLibraryPhotosPath}/keep.jpg` } }] },
      ],
    } );
    readDir.mockResolvedValueOnce( [dirFile( "keep.jpg" ), dirFile( "stale.jpg" )] );

    await clearGalleryPhotos( );

    expect( unlink ).toHaveBeenCalledTimes( 1 );
    expect( unlink ).toHaveBeenCalledWith( `${photoLibraryPhotosPath}/stale.jpg` );
    expect( unlink ).not.toHaveBeenCalledWith( `${photoLibraryPhotosPath}/keep.jpg` );
  } );
} );

const uploadFile = name => ( {
  name,
  path: `${photoUploadPath}/${name}`,
  mtime: new Date( 0 ),
} );

// A Realm with no unsynced observations: everything in photoUploads is
// unreferenced as far as the database is concerned.
const emptyRealm = { objects: ( ) => ( { filtered: ( ) => [] } ) };

describe( "clearSyncedMediaForUpload", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    useStore.setState( { groupedPhotos: [] } );
  } );

  it( "preserves the cropped files of an in-progress Group Photos import", async ( ) => {
    useStore.setState( {
      groupedPhotos: [
        {
          photos: [{
            image: {
              uri: `file://${photoUploadPath}/cropped.jpg`,
              cropOriginalUri: `file://${photoUploadPath}/original.jpg`,
            },
          }],
        },
      ],
    } );
    readDir.mockResolvedValueOnce( [
      uploadFile( "cropped.jpg" ),
      uploadFile( "original.jpg" ),
      uploadFile( "stale.jpg" ),
    ] );

    await clearSyncedMediaForUpload( emptyRealm );

    expect( unlink ).toHaveBeenCalledTimes( 1 );
    expect( unlink ).toHaveBeenCalledWith( `${photoUploadPath}/stale.jpg` );
  } );
} );
