import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { purgeableUsbStagingPath, usbStagingPath } from "appConstants/paths";
import { readableUriForDevicePhoto, sweepUsbStaging } from "sharedHelpers/usbStaging";

const DAY_MS = 24 * 60 * 60 * 1000;
let mockFiles = [];
// Staged name → the folder it is in, when not Documents/usbStaging.
let mockFolders = {};
const mockFolderOf = name => mockFolders[name]
  ?? jest.requireActual( "appConstants/paths" ).usbStagingPath;
const mockUnlink = jest.fn( async path => {
  mockFiles = mockFiles.filter( name => path !== `${mockFolderOf( name )}/${name}` );
} );

jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  DocumentDirectoryPath: "/docs",
  CachesDirectoryPath: "/caches",
  mkdir: async ( ) => undefined,
  copyFile: async ( ) => undefined,
  unlink: path => mockUnlink( path ),
  moveFile: async ( from, to ) => {
    const name = from.split( "/" ).pop( );
    mockFolders[name] = to.slice( 0, to.lastIndexOf( "/" ) );
  },
  readDir: async folder => mockFiles
    .filter( name => mockFolderOf( name ) === folder )
    .map( name => ( {
      name,
      path: `${folder}/${name}`,
      isFile: ( ) => true,
      mtime: new Date( 0 ),
      size: 1,
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
  beforeEach( ( ) => {
    jest.useFakeTimers( { now: 0 } );
    mockFolders = {};
  } );
  afterEach( ( ) => { jest.useRealTimers( ); } );

  it( "saves a faved photo once, and expires it three days after it uploads", async ( ) => {
    const faved = uri( "1_FAVED.JPG" );
    mockFiles = ["1_FAVED.JPG"];
    // Faved before its upload finished: saved to Photos, but no clock yet.
    await sweepUsbStaging( [faved], [] );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      `file://${usbStagingPath}/1_FAVED.JPG`,
      { type: "photo", album: "→ Shared Library" },
    );
    jest.setSystemTime( 10 * DAY_MS );
    await sweepUsbStaging( [faved], [] );
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );

    // Uploaded at day 10.
    await sweepUsbStaging( [faved], [faved] );
    jest.setSystemTime( 12 * DAY_MS );
    await sweepUsbStaging( [faved], [faved] );
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );

    jest.setSystemTime( 14 * DAY_MS );
    await sweepUsbStaging( [faved], [faved] );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 1 );
    expect( mockFiles ).toEqual( [] );
  } );

  it( "expires uploaded and removed photos three days on, and keeps the rest", async ( ) => {
    mockFiles = ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"];
    const expirable = [uri( "1_UPLOADED.JPG" ), uri( "1_REMOVED.JPG" )];
    await sweepUsbStaging( [], expirable );

    jest.setSystemTime( 2 * DAY_MS );
    await sweepUsbStaging( [], expirable );
    expect( mockFiles ).toEqual( ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"] );

    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [], expirable );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );

    // Never uploaded or removed: kept indefinitely.
    jest.setSystemTime( 400 * DAY_MS );
    await sweepUsbStaging( [], [] );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );
  } );

  it( "moves photos whose clock is running to Caches, where iOS may purge them", async ( ) => {
    mockFiles = ["1_UPLOADED.JPG", "1_UNUSED.JPG", "5_FAVED.JPG"];
    const uploaded = uri( "1_UPLOADED.JPG" );
    await sweepUsbStaging( [], [uploaded] );
    expect( mockFolderOf( "1_UPLOADED.JPG" ) ).toBe( purgeableUsbStagingPath );
    expect( readableUriForDevicePhoto( uploaded ) )
      .toBe( `file://${purgeableUsbStagingPath}/1_UPLOADED.JPG` );
    // Never uploaded or removed: stays where iOS won't purge it.
    expect( mockFolderOf( "1_UNUSED.JPG" ) ).toBe( usbStagingPath );

    // A faved photo moves only once it's saved to Photos.
    CameraRoll.saveAsset.mockRejectedValueOnce( new Error( "denied" ) );
    await sweepUsbStaging( [uri( "5_FAVED.JPG" )], [uploaded, uri( "5_FAVED.JPG" )] );
    expect( mockFolderOf( "5_FAVED.JPG" ) ).toBe( usbStagingPath );
    await sweepUsbStaging( [uri( "5_FAVED.JPG" )], [uploaded, uri( "5_FAVED.JPG" )] );
    expect( mockFolderOf( "5_FAVED.JPG" ) ).toBe( purgeableUsbStagingPath );

    // Still expired from Caches.
    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [], [] );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );
  } );

  it( "forgets a photo iOS purged from Caches", async ( ) => {
    mockFiles = ["1_PURGED.JPG"];
    await sweepUsbStaging( [], [uri( "1_PURGED.JPG" )] );
    mockFiles = [];
    await expect( sweepUsbStaging( [], [] ) ).resolves.toBeUndefined( );
    expect( readableUriForDevicePhoto( uri( "1_PURGED.JPG" ) ) )
      .toBe( `file://${usbStagingPath}/1_PURGED.JPG` );
  } );

  it( "goes on expiring photos when Photos refuses to save a faved one", async ( ) => {
    CameraRoll.saveAsset.mockRejectedValue( new Error( "denied" ) );
    // Read in name order, so the faved photo comes before the expiring one.
    mockFiles = ["1_REFUSED.JPG", "2_EXPIRED.JPG"];
    await sweepUsbStaging( [uri( "1_REFUSED.JPG" )], [uri( "2_EXPIRED.JPG" )] );

    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [uri( "1_REFUSED.JPG" )], [uri( "2_EXPIRED.JPG" )] );
    // Past its time, but a faved photo is only deleted once it's saved.
    expect( mockFiles ).toEqual( ["1_REFUSED.JPG"] );
    CameraRoll.saveAsset.mockReset( );
    CameraRoll.saveAsset.mockResolvedValue( {} );
  } );

  it( "saves a faved photo with its import crop when the observation lost it", async ( ) => {
    const { NativeModules } = jest.requireActual( "react-native" );
    const saveCroppedAsset = jest.fn( async ( ) => ( { uri: "ph://CROPPED" } ) );
    NativeModules.ImageCropper = { saveCroppedAsset, addAssetsToAlbum: jest.fn( ) };
    const crop = {
      x: 0.1, y: 0.2, w: 0.5, h: 0.6,
    };
    await jest.isolateModulesAsync( async ( ) => {
      const staging = jest.requireActual( "sharedHelpers/usbStaging" );
      mockFiles = ["1_CROPPED.JPG"];
      staging.recordStagedImportCrop( uri( "1_CROPPED.JPG" ), crop );
      await staging.sweepUsbStaging( [uri( "1_CROPPED.JPG" )], [], undefined, {} );
    } );
    delete NativeModules.ImageCropper;

    expect( saveCroppedAsset ).toHaveBeenCalledWith( "file:///docs/usbStaging/1_CROPPED.JPG", crop );
  } );
} );

describe( "readableUriForDevicePhoto", ( ) => {
  it( "reads a faved photo from the Photos asset it was saved as", async ( ) => {
    CameraRoll.saveAsset.mockResolvedValueOnce( { node: { id: "SAVED" } } );
    mockFiles = ["2_SAVED.HIF"];
    await sweepUsbStaging( [uri( "2_SAVED.HIF" )], [] );
    expect( readableUriForDevicePhoto( uri( "2_SAVED.HIF" ) ) ).toBe( "ph://SAVED" );
  } );

  it( "reads a still-staged photo from the current app container", ( ) => {
    expect( readableUriForDevicePhoto( uri( "3_STAGED.HIF" ) ) )
      .toBe( `file://${usbStagingPath}/3_STAGED.HIF` );
  } );

  it( "leaves other device photos alone", ( ) => {
    expect( readableUriForDevicePhoto( "ph://ASSET" ) ).toBe( "ph://ASSET" );
  } );
} );
