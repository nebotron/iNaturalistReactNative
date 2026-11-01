import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { sweepUsbStaging } from "sharedHelpers/usbStaging";

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

const uri = name => `file:///old/container/usbStaging/${name}`;

describe( "sweepUsbStaging", ( ) => {
  it( "saves faved photos to the Shared Library album", async ( ) => {
    mockFiles = ["1_FAVED.JPG"];
    await sweepUsbStaging( [uri( "1_FAVED.JPG" )], [] );

    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      "file:///docs/usbStaging/1_FAVED.JPG",
      { type: "photo", album: "→ Shared Library" },
    );
    expect( mockFiles ).toEqual( [] );
  } );

  it( "starts the clock when a photo is on an observation or removed", async ( ) => {
    jest.useFakeTimers( { now: 0 } );
    // Staged long ago, but only now put on an observation.
    mockFiles = ["1_ON_OBS.JPG", "1_UNUSED.JPG"];
    await sweepUsbStaging( [], [uri( "1_ON_OBS.JPG" )] );

    jest.setSystemTime( 2 * DAY_MS );
    await sweepUsbStaging( [], [uri( "1_ON_OBS.JPG" )] );
    expect( mockFiles ).toEqual( ["1_ON_OBS.JPG", "1_UNUSED.JPG"] );

    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [], [uri( "1_ON_OBS.JPG" )] );
    // A photo nothing has used yet keeps no clock and stays staged.
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );
    jest.useRealTimers( );
  } );
} );
