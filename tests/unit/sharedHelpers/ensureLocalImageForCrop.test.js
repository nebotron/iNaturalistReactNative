import { NativeModules, Platform } from "react-native";
import ensureLocalImageForCrop from "sharedHelpers/ensureLocalImageForCrop";

const mockFiles = new Set( );
const mockCopyAssets = jest.fn( async ( _uri, path ) => { mockFiles.add( path ); } );
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  copyAssetsFileIOS: ( ...args ) => mockCopyAssets( ...args ),
  downloadFile: jest.fn( ),
  exists: async path => mockFiles.has( path ),
  mkdir: async ( ) => {},
  moveFile: async ( from, to ) => {
    mockFiles.delete( from );
    mockFiles.add( to );
  },
  stat: async ( ) => ( { mtime: Date.now( ) } ),
  unlink: async path => { mockFiles.delete( path ); },
} ) );

const mockExport = jest.fn( );

describe( "ensureLocalImageForCrop with a Photos library asset", ( ) => {
  const originalOS = Platform.OS;

  beforeAll( ( ) => {
    Platform.OS = "ios";
  } );

  afterAll( ( ) => {
    Platform.OS = originalOS;
  } );

  beforeEach( ( ) => {
    mockFiles.clear( );
    mockCopyAssets.mockClear( );
    mockExport.mockReset( );
    NativeModules.ImageCropper = {
      ...NativeModules.ImageCropper,
      exportPHAssetCurrentVersion: ( ...args ) => mockExport( ...args ),
    };
  } );

  it( "exports the photo's own HEIC bytes instead of re-encoding them", async ( ) => {
    mockExport.mockImplementation( async ( _uri, path ) => {
      mockFiles.add( path );
      return { uri: `file://${path}`, uti: "public.heic" };
    } );
    const uri = await ensureLocalImageForCrop( "ph://ASSET-1", "original" );
    expect( uri ).toMatch( /\.heic$/ );
    expect( mockCopyAssets ).not.toHaveBeenCalled( );

    // Served from the cache the second time
    const again = await ensureLocalImageForCrop( "ph://ASSET-1", "original" );
    expect( again ).toEqual( uri );
    expect( mockExport ).toHaveBeenCalledTimes( 1 );
  } );

  it( "falls back to copyAssetsFileIOS for a format it doesn't name", async ( ) => {
    mockExport.mockImplementation( async ( _uri, path ) => {
      mockFiles.add( path );
      return { uri: `file://${path}`, uti: "com.adobe.raw-image" };
    } );
    const uri = await ensureLocalImageForCrop( "ph://ASSET-2", "original" );
    expect( uri ).toMatch( /\.jpg$/ );
    expect( mockCopyAssets ).toHaveBeenCalledTimes( 1 );
    // The unused export isn't left behind
    expect( [...mockFiles].filter( path => path.endsWith( ".tmp" ) ) ).toEqual( [] );
  } );

  it( "falls back to copyAssetsFileIOS when the export fails", async ( ) => {
    mockExport.mockRejectedValue( new Error( "EXPORT_FAILED" ) );
    const uri = await ensureLocalImageForCrop( "ph://ASSET-3", "original" );
    expect( uri ).toMatch( /\.jpg$/ );
    expect( mockCopyAssets ).toHaveBeenCalledTimes( 1 );
  } );
} );
