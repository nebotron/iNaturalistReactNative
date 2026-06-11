import { Alert } from "react-native";
import { deleteOriginalDevicePhotos } from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { zustandStorage } from "stores/useStore";

const mockIosReadGalleryPermission = jest.fn( async () => "not-determined" );
const mockIosRequestReadWriteGalleryPermission = jest.fn( async () => "granted" );
const mockDeletePhotos = jest.fn( async () => undefined );

jest.mock( "@react-native-camera-roll/camera-roll", ( ) => ( {
  CameraRoll: {
    deletePhotos: ( ...args ) => mockDeletePhotos( ...args ),
  },
  iosReadGalleryPermission: ( ...args ) => mockIosReadGalleryPermission( ...args ),
  iosRequestReadWriteGalleryPermission: ( ) => mockIosRequestReadWriteGalleryPermission( ),
} ) );

jest.spyOn( Alert, "alert" ).mockImplementation( ( ) => undefined );

describe( "promptDeleteOriginalDevicePhotos", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    mockIosReadGalleryPermission.mockReset( );
    mockIosRequestReadWriteGalleryPermission.mockReset( );
    mockDeletePhotos.mockReset( );
    zustandStorage.removeItem( "deleteOriginalPhotosPermissionRequested" );
    zustandStorage.removeItem( "deleteOriginalPhotosSettingsPrompted" );
    mockIosReadGalleryPermission.mockResolvedValue( "not-determined" );
    mockIosRequestReadWriteGalleryPermission.mockResolvedValue( "granted" );
  } );

  it( "requests photo library permission for user-initiated deletes", async ( ) => {
    mockIosRequestReadWriteGalleryPermission.mockResolvedValue( "denied" );

    await deleteOriginalDevicePhotos( ["ph://ONE"], { userInitiated: true } );
    await deleteOriginalDevicePhotos( ["ph://TWO"], { userInitiated: true } );

    expect( mockIosRequestReadWriteGalleryPermission ).toHaveBeenCalledTimes( 2 );
    expect( mockDeletePhotos ).not.toHaveBeenCalled( );
    expect( Alert.alert ).toHaveBeenCalledTimes( 2 );
  } );

  it( "deletes when readWrite access is granted", async ( ) => {
    mockIosRequestReadWriteGalleryPermission.mockResolvedValue( "granted" );

    await deleteOriginalDevicePhotos( ["ph://ONE"], { userInitiated: true } );

    expect( mockIosRequestReadWriteGalleryPermission ).toHaveBeenCalled( );
    expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://ONE"] );
    expect( Alert.alert ).not.toHaveBeenCalled( );
  } );
} );
