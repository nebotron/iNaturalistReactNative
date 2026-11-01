import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { sweepUsbStaging, takeUnofferedStagedGroups } from "sharedHelpers/usbStaging";

const DAY_MS = 24 * 60 * 60 * 1000;
let mockFiles = [];
const mockUnlink = jest.fn( async path => {
  mockFiles = mockFiles.filter( name => !path.endsWith( `/${name}` ) );
} );

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  DocumentDirectoryPath: "/docs",
  CachesDirectoryPath: "/caches",
  mkdir: async ( ) => undefined,
  copyFile: async ( ) => undefined,
  unlink: path => mockUnlink( path ),
  readDir: async ( ) => mockFiles.map( name => ( {
    name,
    path: `/docs/usbStaging/${name}`,
    isFile: ( ) => true,
    mtime: new Date( 0 ),
  } ) ),
} ) );

jest.mock( "@react-native-camera-roll/camera-roll", ( ) => ( {
  CameraRoll: { saveAsset: jest.fn( async ( ) => ( {} ) ) },
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: task => task( ( ) => undefined ),
} ) );

describe( "usbStaging", ( ) => {
  it( "saves faved photos to the Shared Library album and expires old ones", async ( ) => {
    const old = Date.now( ) - 4 * DAY_MS;
    const recent = Date.now( ) - DAY_MS;
    const offered = [`${old}_FAVED.JPG`, `${old}_OLD.JPG`, `${recent}_NEW.JPG`];
    mockFiles = [...offered];
    expect( await takeUnofferedStagedGroups( ) ).toHaveLength( 3 );
    mockFiles = [...offered, `${old}_UNOFFERED.JPG`];

    await sweepUsbStaging( [`file:///old/container/usbStaging/${old}_FAVED.JPG`] );

    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 1 );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      `file:///docs/usbStaging/${old}_FAVED.JPG`,
      { type: "photo", album: "→ Shared Library" },
    );
    // Recent photos, and ones never offered to Group Photos, stay staged.
    expect( mockFiles ).toEqual( [`${recent}_NEW.JPG`, `${old}_UNOFFERED.JPG`] );
  } );
} );
