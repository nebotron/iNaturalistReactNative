import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import { usbStagingPath } from "appConstants/paths";
import { readableUriForDevicePhoto, sweepUsbStaging } from "sharedHelpers/usbStaging";
import useStore from "stores/useStore";

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
    await sweepUsbStaging( [uri( "1_FAVED.JPG" )] );

    expect( CameraRoll.saveAsset ).toHaveBeenCalledWith(
      "file:///docs/usbStaging/1_FAVED.JPG",
      { type: "photo", album: "→ Shared Library" },
    );
    expect( mockFiles ).toEqual( [] );
  } );

  it( "deletes every photo three days after it was imported, used or not", async ( ) => {
    jest.useFakeTimers( { now: 0 } );
    // Names carry the import time: one imported at day 0, one at day 2.
    const later = `${2 * DAY_MS}_LATER.JPG`;
    mockFiles = ["1_ON_OBS.JPG", "1_UNUSED.JPG", later];

    jest.setSystemTime( 2.5 * DAY_MS );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( ["1_ON_OBS.JPG", "1_UNUSED.JPG", later] );

    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( [later] );

    jest.setSystemTime( 6 * DAY_MS );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( [] );
    jest.useRealTimers( );
  } );

  it( "keeps a photo an unfinished import still holds past its time", async ( ) => {
    jest.useFakeTimers( { now: 4 * DAY_MS } );
    mockFiles = ["1_IN_IMPORT.JPG", "1_DONE.JPG"];
    useStore.setState( {
      groupedPhotos: [{ photos: [{ image: { uri: uri( "1_IN_IMPORT.JPG" ) } }] }],
    } );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( ["1_IN_IMPORT.JPG"] );

    useStore.setState( { groupedPhotos: [] } );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( [] );
    jest.useRealTimers( );
  } );

  it( "counts a photo with no import time in its name from when it was first seen", async ( ) => {
    jest.useFakeTimers( { now: 10 * DAY_MS } );
    mockFiles = ["NO_TIME.JPG"];
    await sweepUsbStaging( [] );
    jest.setSystemTime( 12 * DAY_MS );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( ["NO_TIME.JPG"] );
    jest.setSystemTime( 14 * DAY_MS );
    await sweepUsbStaging( [] );
    expect( mockFiles ).toEqual( [] );
    jest.useRealTimers( );
  } );

  it( "goes on expiring photos when Photos refuses to save a faved one", async ( ) => {
    jest.useFakeTimers( { now: 0 } );
    CameraRoll.saveAsset.mockRejectedValue( new Error( "denied" ) );
    // Read in name order, so the faved photo comes before the expired one.
    mockFiles = ["1_FAVED.JPG", "2_EXPIRED.JPG"];
    await sweepUsbStaging( [uri( "1_FAVED.JPG" )] );

    jest.setSystemTime( 4 * DAY_MS );
    await sweepUsbStaging( [uri( "1_FAVED.JPG" )] );
    // Past its time, but a faved photo is only ever deleted once it's saved.
    expect( mockFiles ).toEqual( ["1_FAVED.JPG"] );
    CameraRoll.saveAsset.mockReset( );
    CameraRoll.saveAsset.mockResolvedValue( {} );
    jest.useRealTimers( );
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
      await staging.sweepUsbStaging( [uri( "1_CROPPED.JPG" )], undefined, {} );
    } );
    delete NativeModules.ImageCropper;

    expect( saveCroppedAsset ).toHaveBeenCalledWith( "file:///docs/usbStaging/1_CROPPED.JPG", crop );
  } );
} );

describe( "readableUriForDevicePhoto", ( ) => {
  it( "reads a faved photo from the Photos asset it was saved as", async ( ) => {
    CameraRoll.saveAsset.mockResolvedValueOnce( { node: { id: "SAVED" } } );
    mockFiles = ["2_SAVED.HIF"];
    await sweepUsbStaging( [uri( "2_SAVED.HIF" )] );
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
