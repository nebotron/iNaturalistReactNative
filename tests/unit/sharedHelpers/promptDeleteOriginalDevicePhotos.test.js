import { CameraRoll } from "@react-native-camera-roll/camera-roll";
import promptDeleteOriginalDevicePhotos, {
  fileOriginalDevicePhotosForDeletion,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";

const mockAddAssetsToAlbum = jest.fn(
  async uris => ( { added: uris.length, requested: uris.length, alreadyIn: 0 } ),
);
const mockDeletePhotoAssets = jest.fn( async ( ) => ( { deleted: 1 } ) );

jest.mock( "react-native", ( ) => {
  const RN = jest.requireActual( "react-native" );
  RN.Platform.OS = "ios";
  RN.NativeModules.ImageCropper = {
    addAssetsToAlbum: ( ...args ) => mockAddAssetsToAlbum( ...args ),
    deletePhotoAssets: ( ...args ) => mockDeletePhotoAssets( ...args ),
  };
  return RN;
} );

jest.mock( "@react-native-camera-roll/camera-roll", ( ) => ( {
  CameraRoll: { deletePhotos: jest.fn( async ( ) => undefined ) },
} ) );

describe( "promptDeleteOriginalDevicePhotos", ( ) => {
  beforeEach( ( ) => jest.clearAllMocks( ) );

  it( "files the photos into the album and never deletes them", async ( ) => {
    await fileOriginalDevicePhotosForDeletion( ["ph://ONE", "ph://TWO", "ph://ONE"] );

    expect( mockAddAssetsToAlbum ).toHaveBeenCalledWith(
      ["ph://ONE", "ph://TWO"],
      "Imported to iNaturalist",
    );
    expect( mockDeletePhotoAssets ).not.toHaveBeenCalled( );
    expect( CameraRoll.deletePhotos ).not.toHaveBeenCalled( );
  } );

  it( "lets the caller move on straight away", async ( ) => {
    const onComplete = jest.fn( );

    promptDeleteOriginalDevicePhotos( ["ph://ONE"], onComplete );

    expect( onComplete ).toHaveBeenCalledTimes( 1 );
    await new Promise( resolve => { setImmediate( resolve ); } );
    expect( mockAddAssetsToAlbum ).toHaveBeenCalledWith( ["ph://ONE"], "Imported to iNaturalist" );
    expect( mockDeletePhotoAssets ).not.toHaveBeenCalled( );
    expect( CameraRoll.deletePhotos ).not.toHaveBeenCalled( );
  } );

  it( "does nothing when no photo resolves to a library asset", async ( ) => {
    const onComplete = jest.fn( );

    promptDeleteOriginalDevicePhotos( ["file:///tmp/local.jpg", ""], onComplete );

    expect( onComplete ).toHaveBeenCalledTimes( 1 );
    await new Promise( resolve => { setImmediate( resolve ); } );
    expect( mockAddAssetsToAlbum ).not.toHaveBeenCalled( );
  } );
} );
