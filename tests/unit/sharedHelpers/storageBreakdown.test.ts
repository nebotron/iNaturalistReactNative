import { readDir } from "@dr.pogodin/react-native-fs";
import getStorageBreakdown, { categoryForDocument } from "sharedHelpers/storageBreakdown";

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  DocumentDirectoryPath: "/documents",
  CachesDirectoryPath: "/caches",
  TemporaryDirectoryPath: "/caches",
  LibraryDirectoryPath: "",
  MainBundlePath: "",
  readDir: jest.fn( ( ) => Promise.resolve( [] ) ),
} ) );

jest.mock( "react-native-device-info", ( ) => ( {
  getFreeDiskStorage: jest.fn( ( ) => Promise.resolve( 5000 ) ),
} ) );

const file = ( dir: string, name: string, size: number ) => ( {
  name, path: `${dir}/${name}`, size, isDirectory: ( ) => false,
} );
const folder = ( dir: string, name: string ) => ( {
  name, path: `${dir}/${name}`, size: 64, isDirectory: ( ) => true,
} );

const tree: Record<string, ReturnType<typeof file>[]> = {
  "/documents": [
    folder( "/documents", "photoUploads" ),
    file( "/documents", "db.realm", 300 ),
    file( "/documents", "db.realm.lock", 10 ),
    folder( "/documents", "galleryPhotos" ),
    file( "/documents", "stray.txt", 7 ),
  ],
  "/documents/photoUploads": [
    file( "/documents/photoUploads", "a.jpg", 1000 ),
    folder( "/documents/photoUploads", "nested" ),
  ],
  "/documents/photoUploads/nested": [file( "/documents/photoUploads/nested", "b.jpg", 500 )],
  "/documents/galleryPhotos": [file( "/documents/galleryPhotos", "c.jpg", 200 )],
  "/caches": [file( "/caches", "img", 40 )],
};

describe( "categoryForDocument", ( ) => {
  it( "groups a Realm file with its siblings", ( ) => {
    expect( categoryForDocument( "db.realm" ) ).toBe( "database" );
    expect( categoryForDocument( "db.realm.management" ) ).toBe( "database" );
    expect( categoryForDocument( "offlineExplore.realm" ) ).toBe( "offlineExplore" );
    expect( categoryForDocument( "offlineExploreTiles" ) ).toBe( "offlineExplore" );
  } );

  it( "puts unknown entries in other", ( ) => {
    expect( categoryForDocument( "somethingNew" ) ).toBe( "other" );
  } );
} );

describe( "getStorageBreakdown", ( ) => {
  beforeEach( ( ) => {
    ( readDir as jest.Mock ).mockImplementation( ( path: string ) => (
      Promise.resolve( tree[path] ?? [] )
    ) );
  } );

  it( "sums folders recursively into categories, largest first", async ( ) => {
    const breakdown = await getStorageBreakdown( );
    expect( breakdown.categories ).toEqual( [
      { category: "photos", bytes: 1500 },
      { category: "database", bytes: 310 },
      { category: "temporaryPhotos", bytes: 200 },
      { category: "cache", bytes: 40 },
      { category: "other", bytes: 7 },
    ] );
    expect( breakdown.totalBytes ).toBe( 2057 );
    expect( breakdown.freeDiskBytes ).toBe( 5000 );
  } );

  it( "counts a cache directory shared with tmp once", async ( ) => {
    const breakdown = await getStorageBreakdown( );
    expect( breakdown.categories.find( c => c.category === "cache" )?.bytes ).toBe( 40 );
  } );
} );
