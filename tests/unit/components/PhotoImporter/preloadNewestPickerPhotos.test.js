import { CameraRoll, iosReadGalleryPermission } from "@react-native-camera-roll/camera-roll";
import {
  preloadNewestPickerPhotos,
} from "components/PhotoImporter/helpers/preloadNewestPickerPhotos";
import { Platform } from "react-native";

const mockPreload = jest.fn( );
jest.mock( "sharedHelpers/imageCropPreload", ( ) => ( {
  PRELOAD_LOOKAHEAD: 2,
} ) );
jest.mock( "sharedHelpers/pickerCropPreload", ( ) => ( {
  canPreloadPickerPhoto: uri => uri.startsWith( "ph://" ) || uri.startsWith( "file://" ),
  preloadPickerPhoto: ( ...args ) => mockPreload( ...args ),
} ) );

const mockUploaded = new Set( );
jest.mock( "sharedHelpers/duplicateUploadedDevicePhotos", ( ) => ( {
  getPreviouslyUploadedDevicePhotoUrisSet: ( ) => mockUploaded,
} ) );

const mockRemoved = [];
jest.mock( "sharedHelpers/removedGroupPhotoUris", ( ) => ( {
  getRemovedGroupPhotoUris: ( ) => mockRemoved,
} ) );

const mockStaged = [];
jest.mock( "sharedHelpers/usbStaging", ( ) => ( {
  devicePhotoKey: uri => uri,
  listStagedPhotoNodes: async ( ) => mockStaged,
} ) );

jest.mock( "@react-native-camera-roll/camera-roll", ( ) => ( {
  CameraRoll: { getPhotos: jest.fn( ) },
  iosReadGalleryPermission: jest.fn( ),
} ) );

const libraryNode = ( id, timestamp, filename = `${id}.HEIC`, type = "image" ) => ( {
  id, timestamp, type, image: { uri: `ph://${id}`, filename },
} );

const realm = { isClosed: false };

describe( "preloadNewestPickerPhotos", ( ) => {
  const originalOS = Platform.OS;

  beforeAll( ( ) => {
    Platform.OS = "ios";
  } );

  afterAll( ( ) => {
    Platform.OS = originalOS;
  } );

  beforeEach( ( ) => {
    mockPreload.mockClear( );
    CameraRoll.getPhotos.mockReset( );
    mockUploaded.clear( );
    mockRemoved.length = 0;
    mockStaged.length = 0;
    iosReadGalleryPermission.mockResolvedValue( "granted" );
    CameraRoll.getPhotos.mockResolvedValue( {
      edges: [
        libraryNode( "NEWEST", 300 ),
        libraryNode( "GIF", 250, "anim.gif" ),
        libraryNode( "UPLOADED", 200 ),
        libraryNode( "OLDER", 100 ),
      ].map( node => ( { node } ) ),
    } );
  } );

  it( "prepares the newest photos the picker shows, skipping imported ones and GIFs", async ( ) => {
    mockUploaded.add( "ph://UPLOADED" );
    await preloadNewestPickerPhotos( realm );
    expect( mockPreload.mock.calls.map( ( [uri] ) => uri ) )
      .toEqual( ["ph://NEWEST", "ph://OLDER"] );
  } );

  it( "skips photos removed from an earlier import", async ( ) => {
    mockRemoved.push( "ph://NEWEST" );
    await preloadNewestPickerPhotos( realm );
    expect( mockPreload.mock.calls.map( ( [uri] ) => uri ) )
      .toEqual( ["ph://UPLOADED", "ph://OLDER"] );
  } );

  it( "merges staged SD card photos in by time", async ( ) => {
    mockStaged.push( {
      id: "", timestamp: 250, type: "image", image: { uri: "file:///usb/A.JPG", filename: "A.JPG" },
    } );
    await preloadNewestPickerPhotos( realm );
    expect( mockPreload.mock.calls.map( ( [uri] ) => uri ) )
      .toEqual( ["ph://NEWEST", "file:///usb/A.JPG"] );
  } );

  it( "doesn't read the library without access, and never asks for it", async ( ) => {
    iosReadGalleryPermission.mockResolvedValue( "not-determined" );
    mockStaged.push( {
      id: "", timestamp: 1, type: "image", image: { uri: "file:///usb/B.JPG", filename: "B.JPG" },
    } );
    await preloadNewestPickerPhotos( realm );
    expect( CameraRoll.getPhotos ).not.toHaveBeenCalled( );
    expect( mockPreload.mock.calls.map( ( [uri] ) => uri ) ).toEqual( ["file:///usb/B.JPG"] );
  } );
} );
