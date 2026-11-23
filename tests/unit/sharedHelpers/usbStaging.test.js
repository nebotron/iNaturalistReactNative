import { CameraRoll } from "@react-native-camera-roll/camera-roll";

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
  exists: async path => mockFiles.some( name => path.endsWith( `/${name}` ) ),
  unlink: path => mockUnlink( path ),
  readDir: async ( ) => mockFiles.map( name => ( {
    name,
    path: `/docs/usbStaging/${name}`,
    isFile: ( ) => true,
    mtime: new Date( 0 ),
  } ) ),
} ) );

// Instances with the same id share their values, as on a device
const mockStores = new Map( );
jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: class {
    constructor( { id } = { id: "mmkv.default" } ) {
      if ( !mockStores.has( id ) ) mockStores.set( id, new Map( ) );
      this.values = mockStores.get( id );
    }

    getString( key ) {
      const value = this.values.get( key );
      return typeof value === "string"
        ? value
        : undefined;
    }

    getNumber( key ) {
      const value = this.values.get( key );
      return typeof value === "number"
        ? value
        : undefined;
    }

    set( key, value ) { this.values.set( key, value ); }

    delete( key ) { this.values.delete( key ); }

    getAllKeys( ) { return [...this.values.keys( )]; }

    // eslint-disable-next-line class-methods-use-this
    addOnValueChangedListener( ) { return { remove: ( ) => undefined }; }
  },
} ) );

jest.mock( "@react-native-camera-roll/camera-roll", ( ) => ( {
  CameraRoll: { saveAsset: jest.fn( async ( ) => ( {} ) ) },
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: task => task( ( ) => undefined ),
} ) );

const uri = name => `file:///old/container/usbStaging/${name}`;

// A fresh module and store for each test
const loadStaging = ( ) => {
  let staging;
  jest.isolateModules( ( ) => {
    staging = jest.requireActual( "sharedHelpers/usbStaging" );
  } );
  return staging;
};

beforeEach( ( ) => {
  mockStores.clear( );
  CameraRoll.saveAsset.mockClear( );
  jest.useFakeTimers( { now: 0 } );
} );
afterEach( ( ) => { jest.useRealTimers( ); } );

describe( "saveFavedStagedPhotos", ( ) => {
  it( "saves a faved photo to Photos once", async ( ) => {
    const staging = loadStaging( );
    mockFiles = ["1_FAVED.JPG"];
    await staging.saveFavedStagedPhotos( [uri( "1_FAVED.JPG" )] );
    await staging.saveFavedStagedPhotos( [uri( "1_FAVED.JPG" )] );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledTimes( 1 );
    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      "file:///docs/usbStaging/1_FAVED.JPG",
      { type: "photo", album: "→ Shared Library" },
    );
  } );

  it( "reports a refused save for another try", async ( ) => {
    const staging = loadStaging( );
    CameraRoll.saveAsset.mockRejectedValueOnce( new Error( "denied" ) );
    mockFiles = ["1_REFUSED.JPG"];
    const { failed } = await staging.saveFavedStagedPhotos( [uri( "1_REFUSED.JPG" )] );
    expect( failed ).toEqual( [uri( "1_REFUSED.JPG" )] );
    expect( staging.isUnsavedStagedPhoto( uri( "1_REFUSED.JPG" ) ) ).toBe( true );
  } );

  it( "saves a faved photo with its import crop when the observation lost it", async ( ) => {
    const { NativeModules } = jest.requireActual( "react-native" );
    const saveCroppedAsset = jest.fn( async ( ) => ( { uri: "ph://CROPPED" } ) );
    NativeModules.ImageCropper = { saveCroppedAsset, addAssetsToAlbum: jest.fn( ) };
    const crop = {
      x: 0.1, y: 0.2, w: 0.5, h: 0.6,
    };
    const staging = loadStaging( );
    mockFiles = ["1_CROPPED.JPG"];
    staging.recordStagedImportCrop( uri( "1_CROPPED.JPG" ), crop );
    await staging.saveFavedStagedPhotos( [uri( "1_CROPPED.JPG" )] );
    delete NativeModules.ImageCropper;

    expect( saveCroppedAsset ).toHaveBeenCalledWith( "file:///docs/usbStaging/1_CROPPED.JPG", crop );
  } );
} );

describe( "expireStagedPhotos", ( ) => {
  it( "expires photos three days after their clock starts, and keeps the rest", async ( ) => {
    const staging = loadStaging( );
    mockFiles = ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"];
    jest.setSystemTime( 10 * DAY_MS );
    staging.startStagingClocks( [uri( "1_UPLOADED.JPG" ), uri( "1_REMOVED.JPG" )] );
    // Started again later: the first start counts.
    jest.setSystemTime( 11 * DAY_MS );
    staging.startStagingClocks( [uri( "1_UPLOADED.JPG" )] );

    jest.setSystemTime( 13 * DAY_MS );
    await staging.expireStagedPhotos( );
    expect( mockFiles ).toEqual( ["1_UPLOADED.JPG", "1_REMOVED.JPG", "1_UNUSED.JPG"] );

    jest.setSystemTime( 14 * DAY_MS );
    await staging.expireStagedPhotos( );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );

    // Never uploaded or removed: kept indefinitely.
    jest.setSystemTime( 400 * DAY_MS );
    await staging.expireStagedPhotos( );
    expect( mockFiles ).toEqual( ["1_UNUSED.JPG"] );
  } );

  it( "keeps a faved photo until it's been saved", async ( ) => {
    const staging = loadStaging( );
    mockFiles = ["1_FAVED.JPG", "2_EXPIRED.JPG"];
    staging.startStagingClocks( [uri( "1_FAVED.JPG" ), uri( "2_EXPIRED.JPG" )] );
    jest.setSystemTime( 4 * DAY_MS );
    await staging.expireStagedPhotos( name => name === "1_FAVED.JPG" );
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );

    // Looked at again the next day, once it's no longer held.
    jest.setSystemTime( 5 * DAY_MS );
    await staging.expireStagedPhotos( ( ) => false );
    expect( mockFiles ).toEqual( [] );
  } );

  it( "carries clocks over from the single map earlier versions kept", async ( ) => {
    mockFiles = ["1_OLD.JPG"];
    loadStaging( );
    const old = mockStores.get( "usb-staging" );
    old.set( "uploadedOrRemovedAt", JSON.stringify( { "1_OLD.JPG": 0 } ) );
    old.set( "savedUris", JSON.stringify( { "1_OLD.JPG": "ph://OLD" } ) );
    const staging = loadStaging( );
    expect( staging.readableUriForDevicePhoto( uri( "1_OLD.JPG" ) ) ).toBe( "ph://OLD" );
    jest.setSystemTime( 4 * DAY_MS );
    await staging.expireStagedPhotos( );
    expect( mockFiles ).toEqual( [] );
  } );
} );

describe( "readableUriForDevicePhoto", ( ) => {
  it( "reads a faved photo from the Photos asset it was saved as", async ( ) => {
    const staging = loadStaging( );
    CameraRoll.saveAsset.mockResolvedValueOnce( { node: { id: "SAVED" } } );
    mockFiles = ["2_SAVED.HIF"];
    await staging.saveFavedStagedPhotos( [uri( "2_SAVED.HIF" )] );
    expect( staging.readableUriForDevicePhoto( uri( "2_SAVED.HIF" ) ) ).toBe( "ph://SAVED" );
  } );

  it( "reads a still-staged photo from the current app container", ( ) => {
    const staging = loadStaging( );
    expect( staging.readableUriForDevicePhoto( uri( "3_STAGED.HIF" ) ) )
      .toBe( "file:///docs/usbStaging/3_STAGED.HIF" );
  } );

  it( "leaves other device photos alone", ( ) => {
    const staging = loadStaging( );
    expect( staging.readableUriForDevicePhoto( "ph://ASSET" ) ).toBe( "ph://ASSET" );
  } );
} );
