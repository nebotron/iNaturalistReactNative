import { NativeModules } from "react-native";

const mockStore = new Map( );

jest.mock( "react-native-mmkv", ( ) => ( {
  MMKV: class {
    // eslint-disable-next-line class-methods-use-this
    getString( key ) { return mockStore.get( key ); }

    // eslint-disable-next-line class-methods-use-this
    set( key, value ) { mockStore.set( key, value ); }
  },
} ) );

const mockSave = jest.fn( async ( ) => "ph://RESTORED" );
jest.mock( "sharedHelpers/usbStaging", ( ) => ( {
  saveLocalPhotoToLibrary: ( ...args ) => mockSave( ...args ),
} ) );

jest.mock( "sharedHelpers/ensureLocalImageForCrop", ( ) => ( {
  __esModule: true,
  default: async uri => ( uri.startsWith( "http" )
    ? "file:///caches/downloaded.jpg"
    : uri ),
} ) );

jest.mock( "sharedHelpers/promptDeleteOriginalDevicePhotos", ( ) => ( {
  enqueuePhotoLibraryWrite: task => task( ),
} ) );

const mockFiles = new Set( );
jest.mock( "@dr.pogodin/react-native-fs", ( ) => ( {
  exists: async path => mockFiles.has( path ),
} ) );

const mockExisting = jest.fn( );
NativeModules.ImageCropper = {
  ...NativeModules.ImageCropper,
  existingAssets: ( ...args ) => mockExisting( ...args ),
};

const {
  restoredUriFor,
  restoreFavedDevicePhotos,
} = require( "sharedHelpers/restoreFavedDevicePhotos" );

// ObservationPhoto is embedded: Realm refuses to query it on its own.
const realmWith = obsPhotos => ( {
  isClosed: false,
  objects: type => {
    if ( type !== "Observation" ) throw new Error( "You cannot query an embedded object." );
    return {
      filtered: ( query, uris ) => ( obsPhotos
        .some( op => uris.includes( op.originalDevicePhotoUri ) )
        ? [{ observationPhotos: obsPhotos }]
        : [] ),
    };
  },
} );

const identity = uri => uri;

describe( "restoreFavedDevicePhotos", ( ) => {
  beforeEach( ( ) => {
    mockStore.clear( );
    mockSave.mockClear( );
    mockExisting.mockReset( );
    mockFiles.clear( );
  } );

  it( "saves a faved photo missing from Photos back to the library", async ( ) => {
    mockExisting.mockResolvedValue( [] );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://GONE",
      photo: { url: "https://static.inaturalist.org/photos/1/square.jpg" },
    }] );

    const { saved } = await restoreFavedDevicePhotos( realm, ["ph://GONE"], identity );

    expect( mockSave ).toHaveBeenCalledWith( "/caches/downloaded.jpg", undefined );
    expect( saved ).toEqual( ["ph://RESTORED"] );
    expect( restoredUriFor( "ph://GONE" ) ).toEqual( "ph://RESTORED" );
  } );

  it( "leaves a faved photo that is still in Photos alone", async ( ) => {
    mockExisting.mockResolvedValue( ["ph://STILL"] );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://STILL",
      photo: { url: "https://static.inaturalist.org/photos/1/square.jpg" },
    }] );

    const { saved } = await restoreFavedDevicePhotos( realm, ["ph://STILL"], identity );

    expect( mockSave ).not.toHaveBeenCalled( );
    expect( saved ).toEqual( [] );
  } );

  it( "saves nothing when it can't tell which photos are missing", async ( ) => {
    mockExisting.mockRejectedValue( new Error( "limited access" ) );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://GONE",
      photo: { url: "https://static.inaturalist.org/photos/1/square.jpg" },
    }] );

    await restoreFavedDevicePhotos( realm, ["ph://GONE"], identity );

    expect( mockSave ).not.toHaveBeenCalled( );
  } );

  it( "saves the crop original with its crop while the file is there", async ( ) => {
    mockExisting.mockResolvedValue( [] );
    const { photoUploadPath } = require( "appConstants/paths" );
    mockFiles.add( `${photoUploadPath}/orig.jpg` );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://CROPPED",
      photo: {
        url: "https://static.inaturalist.org/photos/1/square.jpg",
        cropOriginalLocalFilePath: "photoUploads/orig.jpg",
        cropX: 0.1,
        cropY: 0.2,
        cropW: 0.5,
        cropH: 0.6,
      },
    }] );

    await restoreFavedDevicePhotos( realm, ["ph://CROPPED"], identity );

    expect( mockSave ).toHaveBeenCalledWith(
      `${photoUploadPath}/orig.jpg`,
      expect.objectContaining( { x: 0.1, w: 0.5 } ),
    );
  } );

  it( "saves the uploaded photo once synced files were swept", async ( ) => {
    mockExisting.mockResolvedValue( [] );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://SWEPT",
      photo: {
        url: "https://static.inaturalist.org/photos/1/square.jpg",
        localFilePath: "photoUploads/cropped.jpg",
        cropOriginalLocalFilePath: "photoUploads/orig.jpg",
        cropX: 0.1,
        cropY: 0.2,
        cropW: 0.5,
        cropH: 0.6,
      },
    }] );

    await restoreFavedDevicePhotos( realm, ["ph://SWEPT"], identity );

    expect( mockSave ).toHaveBeenCalledWith( "/caches/downloaded.jpg", undefined );
  } );

  it( "stops trying a photo that keeps failing", async ( ) => {
    mockExisting.mockResolvedValue( [] );
    mockSave.mockRejectedValue( new Error( "Could not render cropped image" ) );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://BROKEN",
      photo: { url: "https://static.inaturalist.org/photos/1/square.jpg" },
    }] );

    for ( let i = 0; i < 5; i += 1 ) {
      // eslint-disable-next-line no-await-in-loop
      await restoreFavedDevicePhotos( realm, ["ph://BROKEN"], identity );
    }

    expect( mockSave ).toHaveBeenCalledTimes( 3 );
    mockSave.mockReset( );
    mockSave.mockImplementation( async ( ) => "ph://RESTORED" );
  } );

  it( "keeps a photo whose save failed for another try", async ( ) => {
    mockExisting.mockResolvedValue( [] );
    mockSave.mockRejectedValueOnce( new Error( "busy" ) );
    const realm = realmWith( [{
      originalDevicePhotoUri: "ph://GONE",
      photo: { url: "https://static.inaturalist.org/photos/1/square.jpg" },
    }] );

    const { failed } = await restoreFavedDevicePhotos( realm, ["ph://GONE"], identity );

    expect( failed ).toBe( true );
  } );
} );
