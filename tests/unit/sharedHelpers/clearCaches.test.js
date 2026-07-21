import { readDir } from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath } from "appConstants/paths";
import { clearGalleryPhotos } from "sharedHelpers/clearCaches";
import { unlink } from "sharedHelpers/util";
import useStore from "stores/useStore";

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  DocumentDirectoryPath: "/documents",
  exists: jest.fn( ( ) => Promise.resolve( true ) ),
  readDir: jest.fn( ( ) => Promise.resolve( [] ) ),
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
