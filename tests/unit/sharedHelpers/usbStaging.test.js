import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { usbStagingPath } from "appConstants/paths";
import {
  expireUsbStaging,
  readableUriForDevicePhoto,
  saveFavedStagedPhotos,
  startUsbStagingClocks,
} from "sharedHelpers/usbStaging";

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
  exists: async path => mockFiles.some( name => path.endsWith( `/${name}` ) ),
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

describe( "USB staging", ( ) => {
  beforeEach( ( ) => { jest.useFakeTimers( { now: 0 } ); } );
  afterEach( ( ) => { jest.useRealTimers( ); } );

  it( "saves a faved photo once, and expires it three days after it uploads", async ( ) => {
    const faved = uri( "1_FAVED.JPG" );
    const isFaved = name => name === "1_FAVED.JPG";
    mockFiles = ["1_FAVED.JPG"];
    // Faved before its upload finished: saved to Photos, but no clock yet.
    await saveFavedStagedPhotos( [{ uri: faved }] );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      `file://${usbStagingPath}/1_FAVED.JPG`,
      { type: "photo", album: "→ Shared Library" },
    );
    jest.setSystemTime( 10 * DAY_MS );
    await expireUsbStaging( isFaved );
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );

    // Uploaded at day 10.
    startUsbStagingClocks( [faved] );
    jest.setSystemTime( 12 * DAY_MS );
    await saveFavedStagedPhotos( [{ uri: faved }] );
    await expireUsbStaging( isFaved );
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );

    jest.setSystemTime( 14 * DAY_MS );
    await expireUsbStaging( isFaved );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 1 );
    expect( mockFiles ).toEqual( [] );
  } );

  it( "expires uploaded and removed photos three days on, and keeps the rest", async ( ) => {
    mockFiles = ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"];
    startUsbStagingClocks( [uri( "1_UPLOADED.JPG" ), uri( "1_REMOVED.JPG" )] );

    jest.setSystemTime( 2 * DAY_MS );
    // Asked again later, the clock keeps its start
    startUsbStagingClocks( [uri( "1_UPLOADED.JPG" )] );
    await expireUsbStaging( );
    expect( mockFiles ).toEqual( ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"] );

    jest.setSystemTime( 4 * DAY_MS );
    await expireUsbStaging( );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );

    // Never uploaded or removed: kept indefinitely.
    jest.setSystemTime( 400 * DAY_MS );
    await expireUsbStaging( );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );
  } );

  it( "keeps a faved photo Photos refused to save, and expires the rest", async ( ) => {
    CameraRoll.saveAsset.mockRejectedValue( new Error( "denied" ) );
    mockFiles = ["1_REFUSED.JPG", "2_EXPIRED.JPG"];
    const { refused } = await saveFavedStagedPhotos( [{ uri: uri( "1_REFUSED.JPG" ) }] );
    expect( refused ).toBe( true );
    startUsbStagingClocks( [uri( "1_REFUSED.JPG" ), uri( "2_EXPIRED.JPG" )] );

    jest.setSystemTime( 4 * DAY_MS );
    const isFaved = jest.fn( name => name === "1_REFUSED.JPG" );
    await expireUsbStaging( isFaved );
    // Past its time, but a faved photo is only deleted once it's saved.
    expect( mockFiles ).toEqual( ["1_REFUSED.JPG"] );
    CameraRoll.saveAsset.mockReset( );
    CameraRoll.saveAsset.mockResolvedValue( {} );
  } );

  it( "asks whether a photo is faved only once its time is up", async ( ) => {
    mockFiles = ["1_EARLY.JPG", "2_LATE.JPG", "3_UNCLOCKED.JPG"];
    startUsbStagingClocks( [uri( "1_EARLY.JPG" )] );
    jest.setSystemTime( 3.5 * DAY_MS );
    startUsbStagingClocks( [uri( "2_LATE.JPG" )] );
    jest.setSystemTime( 4 * DAY_MS );
    const isFaved = jest.fn( ( ) => false );
    await expireUsbStaging( isFaved );
    expect( isFaved.mock.calls ).toEqual( [["1_EARLY.JPG"]] );
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
      await staging.saveFavedStagedPhotos( [{ uri: uri( "1_CROPPED.JPG" ) }] );
    } );
    delete NativeModules.ImageCropper;

    expect( saveCroppedAsset ).toHaveBeenCalledWith( "file:///docs/usbStaging/1_CROPPED.JPG", crop );
  } );
} );

describe( "readableUriForDevicePhoto", ( ) => {
  it( "reads a faved photo from the Photos asset it was saved as", async ( ) => {
    CameraRoll.saveAsset.mockResolvedValueOnce( { node: { id: "SAVED" } } );
    mockFiles = ["2_SAVED.HIF"];
    await saveFavedStagedPhotos( [{ uri: uri( "2_SAVED.HIF" ) }] );
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
