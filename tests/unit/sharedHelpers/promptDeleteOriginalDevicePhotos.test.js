import { Alert } from "react-native";
import promptDeleteOriginalDevicePhotos, {
  clearPhotoLibraryWriteFailure,
  deleteOriginalDevicePhotos,
  isInPhotoLibraryWriteCooldown,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { zustandStorage } from "stores/useStore";

const mockIosReadGalleryPermission = jest.fn( async () => "not-determined" );
const mockIosRequestReadWriteGalleryPermission = jest.fn( async () => "granted" );
const mockDeletePhotos = jest.fn( async () => undefined );
const mockLogger = {
  info: jest.fn( ),
  warn: jest.fn( ),
  error: jest.fn( ),
  infoWithExtra: jest.fn( ),
  errorWithExtra: jest.fn( ),
};

// The methods have to stay wrappers: extend( ) runs while the module under
// test is first imported, before mockLogger itself is initialized.
jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      info: ( ...args ) => mockLogger.info( ...args ),
      warn: ( ...args ) => mockLogger.warn( ...args ),
      error: ( ...args ) => mockLogger.error( ...args ),
      infoWithExtra: ( ...args ) => mockLogger.infoWithExtra( ...args ),
      errorWithExtra: ( ...args ) => mockLogger.errorWithExtra( ...args ),
    } ),
  },
} ) );

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

  it( "deletes when access is limited", async ( ) => {
    mockIosRequestReadWriteGalleryPermission.mockResolvedValue( "limited" );

    await deleteOriginalDevicePhotos( ["ph://ONE"], { userInitiated: true } );

    expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://ONE"] );
    expect( Alert.alert ).not.toHaveBeenCalled( );
  } );

  it( "keeps the happy path quiet about permissions and presentation context", async ( ) => {
    mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );

    await deleteOriginalDevicePhotos( ["ph://ONE"] );

    const infoLines = mockLogger.info.mock.calls.map( call => String( call[0] ) );
    expect( infoLines.some( line => line.includes( "permission status" ) ) ).toBe( false );
    expect( infoLines.some( line => line.includes( "deletion context" ) ) ).toBe( false );
    expect( infoLines.some( line => line.includes( "ph://" ) ) ).toBe( false );
  } );

  describe( "when the deletion hangs", ( ) => {
    beforeEach( ( ) => jest.useFakeTimers( ) );
    afterEach( ( ) => jest.useRealTimers( ) );

    it( "stops waiting so the caller can leave the screen, and completes once", async ( ) => {
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );
      const onComplete = jest.fn( );

      promptDeleteOriginalDevicePhotos( ["ph://ONE"], onComplete );
      // let the permission check and the deletion call itself settle
      await jest.advanceTimersByTimeAsync( 0 );
      expect( onComplete ).not.toHaveBeenCalled( );

      await jest.advanceTimersByTimeAsync( 20000 );
      expect( onComplete ).toHaveBeenCalledTimes( 1 );

      // the deletion finishing after we gave up must not complete the exit twice
      finishDeletion( );
      await jest.advanceTimersByTimeAsync( 0 );
      expect( onComplete ).toHaveBeenCalledTimes( 1 );
    } );

    it( "reports what the app was doing while the delete hung, without the URIs", async ( ) => {
      // Resolvable rather than eternally pending: every delete goes through one
      // module-level chain, so a promise left hanging here blocks the deletes
      // in every test that follows.
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE", "ph://TWO"] );
      await jest.advanceTimersByTimeAsync( 20000 );
      finishDeletion( { deleted: 2, requested: 2 } );
      await deletion;

      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_pending_20s",
        expect.objectContaining( {
          requested: 2,
          ms: 20000,
          leftForeground: false,
          appStateChanges: 0,
        } ),
      );
      const [, extra] = mockLogger.errorWithExtra.mock.calls[0];
      // Counted for the whole session, so other hangs in this file add to it.
      expect( extra.hangsThisSession ).toBeGreaterThanOrEqual( 1 );
      expect( JSON.stringify( extra ) ).not.toContain( "ph://" );
    } );

    it( "arms the cooldown as soon as the hang is detected", async ( ) => {
      clearPhotoLibraryWriteFailure( );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 19000 );
      expect( isInPhotoLibraryWriteCooldown( ) ).toBe( false );

      // The app is routinely killed before the 120s timeout could record the
      // failure, so a cooldown armed only there never survived to the relaunch.
      await jest.advanceTimersByTimeAsync( 1000 );
      expect( isInPhotoLibraryWriteCooldown( ) ).toBe( true );

      finishDeletion( { deleted: 1, requested: 1 } );
      await deletion;
    } );

    it( "clears the cooldown when a slow delete does come back", async ( ) => {
      clearPhotoLibraryWriteFailure( );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 20000 );
      expect( isInPhotoLibraryWriteCooldown( ) ).toBe( true );

      finishDeletion( { deleted: 1, requested: 1 } );
      await deletion;
      expect( isInPhotoLibraryWriteCooldown( ) ).toBe( false );
    } );
  } );
} );
