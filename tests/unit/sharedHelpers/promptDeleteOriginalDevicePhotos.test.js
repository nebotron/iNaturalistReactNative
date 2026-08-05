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
const mockPhotoDeletionContext = jest.fn( async ( ) => "appState=0" );
const mockPhotoLibraryWriteProbe = jest.fn( async ( ) => ( { ok: true, ms: 3, error: "" } ) );

// The module under test destructures NativeModules.ImageCropper at import time,
// so the native helper has to exist before that import runs. deletePhotoAssets
// is left off, keeping the deletion itself on the CameraRoll fallback the other
// tests drive.
jest.mock( "react-native", ( ) => {
  const RN = jest.requireActual( "react-native" );
  RN.NativeModules.ImageCropper = {
    photoDeletionContext: ( ...args ) => mockPhotoDeletionContext( ...args ),
    photoLibraryWriteProbe: ( ...args ) => mockPhotoLibraryWriteProbe( ...args ),
  };
  return RN;
} );
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
    mockPhotoLibraryWriteProbe.mockReset( );
    mockPhotoLibraryWriteProbe.mockResolvedValue( { ok: true, ms: 3, error: "" } );
    // The cooldown is persisted, so a test that arms it otherwise makes every
    // test after it skip its deletion before reaching what it meant to check.
    clearPhotoLibraryWriteFailure( );
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

  describe( "preflighting a consent-free library write", ( ) => {
    it( "deletes normally when the probe comes back", async ( ) => {
      await deleteOriginalDevicePhotos( ["ph://ONE"] );

      expect( mockPhotoLibraryWriteProbe ).toHaveBeenCalledTimes( 1 );
      expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://ONE"] );
      // A healthy preflight is the common case; a line per delete would be
      // pure volume.
      expect( mockLogger.errorWithExtra ).not.toHaveBeenCalledWith(
        "photo_delete_preflight",
        expect.anything( ),
      );
    } );

    describe( "when the probe never settles", ( ) => {
      beforeEach( ( ) => jest.useFakeTimers( ) );
      afterEach( ( ) => jest.useRealTimers( ) );

      it( "skips the doomed deletion and arms the cooldown", async ( ) => {
        clearPhotoLibraryWriteFailure( );
        mockPhotoLibraryWriteProbe.mockImplementation( ( ) => new Promise( ( ) => {} ) );

        const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
        await jest.advanceTimersByTimeAsync( 10000 );
        const result = await deletion;

        // A library that can't complete a write the app owns outright can't
        // complete a deletion needing a consent alert on top, so there is
        // nothing to gain by spending 120s finding out.
        expect( mockDeletePhotos ).not.toHaveBeenCalled( );
        expect( result ).toEqual( { deleted: 0, requested: 1, succeeded: false } );
        expect( isInPhotoLibraryWriteCooldown( ) ).toBe( true );
        expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
          "photo_delete_preflight",
          expect.objectContaining( { requested: 1, probeOk: false } ),
        );
      } );
    } );
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

    it( "re-reads the presentation context at the hang", async ( ) => {
      mockPhotoDeletionContext.mockResolvedValue( "appState=0 vcChain=UIViewController" );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 20000 );

      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_hang_context",
        expect.objectContaining( {
          requested: 1,
          mainQueueResponsive: true,
          contextAtHang: "appState=0 vcChain=UIViewController",
        } ),
      );

      finishDeletion( { deleted: 1, requested: 1 } );
      await deletion;
    } );

    it( "reports a main queue that never answers as the hang's own explanation", async ( ) => {
      mockPhotoDeletionContext.mockImplementation( ( ) => new Promise( ( ) => {} ) );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      // The context call never comes back, so the delete only starts once that
      // diagnostic gives up — it must not hold the deletion open indefinitely.
      await jest.advanceTimersByTimeAsync( 5000 );
      expect( mockDeletePhotos ).toHaveBeenCalled( );

      await jest.advanceTimersByTimeAsync( 20000 );
      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_hang_context",
        expect.objectContaining( { mainQueueResponsive: false } ),
      );

      finishDeletion( { deleted: 1, requested: 1 } );
      await deletion;
    } );
  } );
} );
