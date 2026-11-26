import { NativeModules, Platform } from "react-native";
import {
  aliasPreload,
  enqueuePreload,
  preloadCache,
  promotePreloads,
} from "sharedHelpers/imageCropPreload";
import { preloadPickerPhoto } from "sharedHelpers/pickerCropPreload";

const mockUnlink = jest.fn( async ( ) => {} );
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  exists: async ( ) => false,
  mkdir: async ( ) => {},
} ) );
jest.mock( "sharedHelpers/util", ( ) => ( {
  unlink: ( ...args ) => mockUnlink( ...args ),
} ) );

const mockPrepare = jest.fn( );
jest.mock( "sharedHelpers/prepareCropSource", ( ) => ( {
  __esModule: true,
  default: ( ...args ) => mockPrepare( ...args ),
} ) );

const mockExportOriginal = jest.fn( );
const mockExportCurrentVersion = jest.fn( );

const flush = ( ) => new Promise( resolve => { setTimeout( resolve, 0 ); } );

// The order photos were prepared in, by the file each was prepared from
const preparedOrder = ( ) => mockPrepare.mock.calls.map( ( [imageUri] ) => imageUri );

describe( "pickerCropPreload", ( ) => {
  const originalOS = Platform.OS;

  beforeAll( ( ) => {
    Platform.OS = "ios";
  } );

  afterAll( ( ) => {
    Platform.OS = originalOS;
  } );

  beforeEach( ( ) => {
    preloadCache.clear( );
    mockUnlink.mockClear( );
    mockExportOriginal.mockReset( ).mockResolvedValue( {} );
    mockExportCurrentVersion.mockReset( );
    mockPrepare.mockReset( ).mockImplementation( async ( imageUri, resolvedUri ) => ( {
      displayUri: `${resolvedUri}.display.jpg`,
      size: { w: 4000, h: 3000 },
      crop: {
        x: 0, y: 0, w: 1, h: 1,
      },
    } ) );
    NativeModules.ImageCropper = {
      ...NativeModules.ImageCropper,
      exportPHAsset: ( ...args ) => mockExportOriginal( ...args ),
      exportPHAssetCurrentVersion: ( ...args ) => mockExportCurrentVersion( ...args ),
    };
  } );

  it( "prepares a library photo from its original bytes, not its edited version", async ( ) => {
    preloadPickerPhoto( "ph://ASSET-1/L0/001", "IMG_0001.HEIC" );
    const result = await enqueuePreload( "ph://ASSET-1/L0/001", "ph://ASSET-1/L0/001", null );
    expect( mockExportOriginal ).toHaveBeenCalledTimes( 1 );
    expect( mockExportCurrentVersion ).not.toHaveBeenCalled( );
    expect( result.localUri ).toMatch( /picker_ASSET_1_L0_001\.heic$/ );
    expect( result.size ).toEqual( { w: 4000, h: 3000 } );
  } );

  it( "hands the prepare to the imported copy and drops the scratch export", async ( ) => {
    preloadPickerPhoto( "ph://ASSET-2", "IMG_0002.JPG" );
    await enqueuePreload( "ph://ASSET-2", "ph://ASSET-2", null );
    aliasPreload( "ph://ASSET-2", "file:///photoLibraryPhotos/IMG_0002.JPG" );
    const imported = await enqueuePreload(
      "file:///photoLibraryPhotos/IMG_0002.JPG",
      "file:///photoLibraryPhotos/IMG_0002.JPG",
      null,
    );
    expect( imported.localUri ).toBe( "file:///photoLibraryPhotos/IMG_0002.JPG" );
    // Prepared once, under the library URI, not again for the copy
    expect( mockPrepare ).toHaveBeenCalledTimes( 1 );
    await flush( );
    expect( mockUnlink ).toHaveBeenCalledWith( expect.stringMatching( /picker_ASSET_2\.jpg$/ ) );
    expect( preloadCache.has( "ph://ASSET-2" ) ).toBe( false );
  } );

  it( "prepares a staged SD card photo from its own file, with no export", async ( ) => {
    preloadPickerPhoto( "file:///usbStaging/1_IMG.JPG", "1_IMG.JPG" );
    const result = await enqueuePreload(
      "file:///usbStaging/1_IMG.JPG",
      "file:///usbStaging/1_IMG.JPG",
      null,
    );
    expect( mockExportOriginal ).not.toHaveBeenCalled( );
    expect( result.localUri ).toBe( "file:///usbStaging/1_IMG.JPG" );
  } );

  it( "keeps a prepare nobody picked, for a later batch", async ( ) => {
    preloadPickerPhoto( "file:///usbStaging/2_IMG.JPG", "2_IMG.JPG" );
    await flush( );
    await flush( );
    expect( preloadCache.has( "file:///usbStaging/2_IMG.JPG" ) ).toBe( true );
    expect( mockUnlink ).not.toHaveBeenCalled( );
  } );

  it( "runs a photo a crop is waiting on before ones prepared ahead", async ( ) => {
    // The first holds the queue's only slot, so the rest queue behind it
    let finishFirst;
    mockPrepare.mockImplementationOnce( ( imageUri, resolvedUri ) => new Promise( resolve => {
      finishFirst = ( ) => resolve( {
        displayUri: `${resolvedUri}.display.jpg`,
        size: { w: 1, h: 1 },
        crop: {
          x: 0, y: 0, w: 1, h: 1,
        },
      } );
    } ) );
    preloadPickerPhoto( "file:///usbStaging/A.JPG", "A.JPG" );
    preloadPickerPhoto( "file:///usbStaging/B.JPG", "B.JPG" );
    preloadPickerPhoto( "file:///usbStaging/C.JPG", "C.JPG" );
    const cropping = enqueuePreload( "file:///imported/D.JPG", "file:///imported/D.JPG", null );
    promotePreloads( ["file:///usbStaging/C.JPG"] );
    await flush( );
    finishFirst( );
    await cropping;
    await flush( );
    await flush( );
    expect( preparedOrder( ) ).toEqual( [
      "file:///usbStaging/A.JPG",
      // Picked, so promoted ahead of the one prepared in case
      "file:///usbStaging/C.JPG",
      "file:///imported/D.JPG",
      "file:///usbStaging/B.JPG",
    ] );
  } );

  it( "doesn't treat a mis-prefixed file path as a library asset", ( ) => {
    preloadPickerPhoto( "ph:///var/mobile/IMG.jpg", "IMG.jpg" );
    expect( mockExportOriginal ).not.toHaveBeenCalled( );
  } );
} );
