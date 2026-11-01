import { NativeModules } from "react-native";

const mockStore = new Map( );

jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: class {
    // eslint-disable-next-line class-methods-use-this
    getString( key ) { return mockStore.get( key ); }

    // eslint-disable-next-line class-methods-use-this
    set( key, value ) { mockStore.set( key, value ); }

    // eslint-disable-next-line class-methods-use-this
    delete( key ) { mockStore.delete( key ); }
  },
} ) );

const mockRecordAppCreatedPhotoAssets = jest.fn( );
jest.mock( "sharedHelpers/appCreatedPhotoAssets", ( ) => ( {
  recordAppCreatedPhotoAssets: ids => mockRecordAppCreatedPhotoAssets( ids ),
} ) );

let nativeSaved = {};
NativeModules.UsbStorage = {
  getSavedImages: jest.fn( async ( ) => ( { ...nativeSaved } ) ),
  clearSavedImages: jest.fn( async paths => {
    paths.forEach( path => { delete nativeSaved[path]; } );
  } ),
  listNewImages: jest.fn( async knownNames => ( {
    available: true, reason: "ok", images: [], knownNames,
  } ) ),
};

// Required after the native module is in place, since usbStorage reads it at load.
const {
  getPendingUsbDeletes,
  listNewUsbImages,
  reconcileSavedUsbImages,
} = require( "sharedHelpers/usbStorage" );

describe( "reconcileSavedUsbImages", ( ) => {
  beforeEach( ( ) => {
    mockStore.clear( );
    nativeSaved = {};
    jest.clearAllMocks( );
  } );

  // A save that landed in Photos after its JS timeout fired, or just before the
  // app was killed, must count as imported so a restarted run skips it.
  it( "marks saves the offload loop never heard back from as imported", async ( ) => {
    nativeSaved = { "DCIM/IMG_1.CR3": "id-1" };

    expect( await reconcileSavedUsbImages( ) ).toBe( 1 );
    const { knownNames } = await listNewUsbImages( );
    expect( knownNames ).toEqual( ["DCIM/IMG_1.CR3"] );
    expect( getPendingUsbDeletes( ) ).toEqual( ["DCIM/IMG_1.CR3"] );
    expect( mockRecordAppCreatedPhotoAssets ).toHaveBeenCalledWith( ["id-1"] );
    expect( nativeSaved ).toEqual( {} );
  } );

  it( "does not record a save the loop already marked", async ( ) => {
    nativeSaved = { "DCIM/IMG_1.CR3": "id-1" };
    await reconcileSavedUsbImages( );
    nativeSaved = { "DCIM/IMG_1.CR3": "id-1" };

    expect( await reconcileSavedUsbImages( ) ).toBe( 0 );
    const { knownNames } = await listNewUsbImages( );
    expect( knownNames ).toEqual( ["DCIM/IMG_1.CR3"] );
    expect( nativeSaved ).toEqual( {} );
  } );
} );
