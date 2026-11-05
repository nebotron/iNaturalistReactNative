import {
  copyFile,
  exists,
  mkdir,
} from "@dr.pogodin/react-native-fs";
import { photoLibraryPhotosPath } from "appConstants/paths";
import {
  isSharedAudio,
  moveSharedGroupedPhotos,
  stageSharedSound,
} from "sharedHelpers/shareExtensionFiles";
import { unlink } from "sharedHelpers/util";

jest.mock( "@dr.pogodin/react-native-fs", () => ( {
  __esModule: true,
  CachesDirectoryPath: "caches/directory/path",
  DocumentDirectoryPath: "document/directory/path",
  copyFile: jest.fn( ).mockResolvedValue( undefined ),
  exists: jest.fn( ).mockResolvedValue( true ),
  mkdir: jest.fn( ).mockResolvedValue( undefined ),
} ) );

jest.mock( "react-native", () => ( {
  Platform: { OS: "ios" },
} ) );

jest.mock( "uuid", () => ( { v4: ( ) => "test-uuid" } ) );

jest.mock( "sharedHelpers/util", () => ( {
  __esModule: true,
  unlink: jest.fn( ).mockResolvedValue( undefined ),
} ) );

const APP_GROUP_URI_1 = "file:///private/var/mobile/Containers/Shared/AppGroup/abc/photo1.jpeg";
const APP_GROUP_URI_2 = "file:///private/var/mobile/Containers/Shared/AppGroup/abc/photo2.jpeg";
const APP_GROUP_PATH_1 = "/private/var/mobile/Containers/Shared/AppGroup/abc/photo1.jpeg";
const APP_GROUP_PATH_2 = "/private/var/mobile/Containers/Shared/AppGroup/abc/photo2.jpeg";
const GALLERY_URI_1 = `file://${photoLibraryPhotosPath}/photo1.jpeg`;
const GALLERY_URI_2 = `file://${photoLibraryPhotosPath}/photo2.jpeg`;

beforeEach( ( ) => {
  jest.clearAllMocks( );
  exists.mockResolvedValue( true );
} );

describe( "moveSharedGroupedPhotos", ( ) => {
  it( "moves App Group share photos into galleryPhotos and preserves group shape", async () => {
    const groupedPhotos = [
      { photos: [{ image: { uri: APP_GROUP_URI_1 } }] },
      {
        photos: [
          { image: { uri: APP_GROUP_URI_2 } },
          { image: { uri: APP_GROUP_URI_1 } },
        ],
      },
    ];

    const staged = await moveSharedGroupedPhotos( groupedPhotos );

    expect( mkdir ).toHaveBeenCalledWith( photoLibraryPhotosPath );
    expect( copyFile ).toHaveBeenCalledWith(
      APP_GROUP_PATH_1,
      `${photoLibraryPhotosPath}/photo1.jpeg`,
    );
    expect( copyFile ).toHaveBeenCalledWith(
      APP_GROUP_PATH_2,
      `${photoLibraryPhotosPath}/photo2.jpeg`,
    );
    expect( unlink ).toHaveBeenCalledWith( APP_GROUP_PATH_1 );
    expect( staged ).toEqual( [
      { photos: [{ image: { uri: GALLERY_URI_1 } }] },
      {
        photos: [
          { image: { uri: GALLERY_URI_2 } },
          { image: { uri: GALLERY_URI_1 } },
        ],
      },
    ] );
  } );

  it( "leaves non-App-Group URIs unchanged within groups", async () => {
    const galleryUri = `file://${photoLibraryPhotosPath}/existing.jpeg`;
    const groupedPhotos = [
      { photos: [{ image: { uri: galleryUri }, timestamp: 1 }] },
    ];

    const staged = await moveSharedGroupedPhotos( groupedPhotos );

    expect( copyFile ).not.toHaveBeenCalled( );
    expect( staged ).toEqual( groupedPhotos );
  } );
} );

describe( "isSharedAudio", ( ) => {
  it( "recognizes audio by MIME type or by extension", ( ) => {
    expect( isSharedAudio( { mimeType: "audio/x-m4a", data: "file:///a/memo" } ) ).toBe( true );
    expect( isSharedAudio( { mimeType: "*/*", data: "file:///a/memo.M4A" } ) ).toBe( true );
    expect( isSharedAudio( { mimeType: "image/jpeg", data: "file:///a/p.jpg" } ) ).toBe( false );
    expect( isSharedAudio( { mimeType: "application/pdf", data: "file:///a/d.pdf" } ) )
      .toBe( false );
  } );
} );

describe( "stageSharedSound", ( ) => {
  it( "copies an App Group voice memo into caches and removes the source", async ( ) => {
    const source = "/private/var/mobile/Containers/Shared/AppGroup/abc/memo.m4a";

    const uri = await stageSharedSound( { mimeType: "audio/x-m4a", data: `file://${source}` } );

    const dest = "caches/directory/path/shared_audio_test-uuid.m4a";
    expect( copyFile ).toHaveBeenCalledWith( source, dest );
    expect( unlink ).toHaveBeenCalledWith( source );
    expect( uri ).toEqual( `file://${dest}` );
  } );

  it( "copies an Android content uri as-is", async ( ) => {
    const source = "content://com.example.recorder/audio/42";

    const uri = await stageSharedSound( { mimeType: "audio/mpeg", data: source } );

    const dest = "caches/directory/path/shared_audio_test-uuid.m4a";
    expect( copyFile ).toHaveBeenCalledWith( source, dest );
    expect( unlink ).not.toHaveBeenCalled( );
    expect( uri ).toEqual( `file://${dest}` );
  } );
} );
