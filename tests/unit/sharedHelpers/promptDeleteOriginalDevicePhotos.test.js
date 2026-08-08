import { Alert, AppState } from "react-native";
import promptDeleteOriginalDevicePhotos, {
  deleteOriginalDevicePhotos,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import { zustandStorage } from "stores/useStore";

const mockIosReadGalleryPermission = jest.fn( async () => "not-determined" );
const mockIosRequestReadWriteGalleryPermission = jest.fn( async () => "granted" );
const mockDeletePhotos = jest.fn( async () => undefined );
const mockPhotoDeletionContext = jest.fn( async ( ) => "appState=0" );

// The module under test destructures NativeModules.ImageCropper at import time,
// so the native helper has to exist before that import runs. deletePhotoAssets
// is left off, keeping the deletion itself on the CameraRoll fallback the other
// tests drive.
jest.mock( "react-native", ( ) => {
  const RN = jest.requireActual( "react-native" );
  RN.NativeModules.ImageCropper = {
    photoDeletionContext: ( ...args ) => mockPhotoDeletionContext( ...args ),
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

      // The deletion stops being waited on inside the 20s the caller would
      // otherwise sit there for.
      await jest.advanceTimersByTimeAsync( 15000 );
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
      await jest.advanceTimersByTimeAsync( 5000 );
      finishDeletion( { deleted: 2, requested: 2 } );
      await deletion;

      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_pending",
        expect.objectContaining( {
          requested: 2,
          ms: 5000,
          backgrounded: false,
          wentInactive: false,
          appStateChanges: 0,
          // Which transaction was in flight. A hang with prompted=0 issued only
          // the consent-free half, which is what kills the consent-alert
          // explanation, so it has to be on the hang report itself.
          appCreated: 0,
          prompted: 2,
        } ),
      );
      const [, extra] = mockLogger.errorWithExtra.mock.calls[0];
      // Counted for the whole session, so other hangs in this file add to it.
      expect( extra.hangsThisSession ).toBeGreaterThanOrEqual( 1 );
      expect( JSON.stringify( extra ) ).not.toContain( "ph://" );
    } );

    it( "does not report a foreground-inactive app as having left the foreground", async ( ) => {
      // These deletes are issued straight after a navigation or a modal
      // dismissal, so the app is routinely foreground-inactive when one starts
      // — the Aug 6 log's three *successful* deletions all report
      // sceneState=1. Folding that into "left the foreground" made the flag
      // true before the delete began, and a theory about backgrounded consent
      // alerts was built on one hang reporting it.
      const previousState = AppState.currentState;
      AppState.currentState = "inactive";
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 5000 );
      finishDeletion( { deleted: 1, requested: 1 } );
      await deletion;
      AppState.currentState = previousState;

      const [, extra] = mockLogger.errorWithExtra.mock.calls
        .filter( ( [marker] ) => marker === "photo_delete_pending" ).at( -1 );
      expect( extra.backgrounded ).toBe( false );
      expect( extra.wentInactive ).toBe( true );
    } );

    it( "reports an unanswered delete as pending, not as a failure", async ( ) => {
      let finishDeletion;
      mockDeletePhotos.mockImplementationOnce(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const pending = deleteOriginalDevicePhotos( ["ph://ONE"], { userInitiated: true } );
      await jest.advanceTimersByTimeAsync( 15000 );

      // iOS is still holding the transaction and usually still carries the
      // deletion out, so a caller must be able to tell this from a real
      // failure — and the user must not be told it went wrong.
      expect( await pending ).toEqual( {
        deleted: 0, requested: 1, succeeded: false, pending: true,
      } );
      expect( Alert.alert ).not.toHaveBeenCalled( );

      // Whether the abandoned deletion eventually lands is the question the log
      // could not answer before.
      finishDeletion( { deleted: 1, requested: 1 } );
      await jest.advanceTimersByTimeAsync( 0 );
      expect( mockLogger.info.mock.calls.map( call => String( call[0] ) ).some(
        line => line.includes( "after the UI stopped waiting" ),
      ) ).toBe( true );
    } );

    it( "holds the write chain until the abandoned native call settles", async ( ) => {
      // A JS timeout does not close the transaction iOS opened. Starting a
      // second performChanges behind an open one is what wedges photolibraryd,
      // so the next write waits for the transaction, not for our patience.
      let finishDeletion;
      mockDeletePhotos.mockImplementationOnce(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const pending = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 15000 );
      expect( await pending ).toMatchObject( { pending: true } );

      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      const next = deleteOriginalDevicePhotos( ["ph://TWO"] );
      await jest.advanceTimersByTimeAsync( 1000 );
      expect( mockDeletePhotos ).not.toHaveBeenCalledWith( ["ph://TWO"] );

      // Nothing is remembered from a delete that went wrong: a wedged
      // PHPhotoLibrary recovers when the user restarts the device, and asking is
      // the only way to find out that it has.
      finishDeletion( );
      await jest.advanceTimersByTimeAsync( 0 );
      expect( await next ).toEqual( { deleted: 1, requested: 1, succeeded: true } );
      expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://TWO"] );
    } );

    it( "re-reads the presentation context at the hang", async ( ) => {
      mockPhotoDeletionContext.mockResolvedValue( "appState=0 vcChain=UIViewController" );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const deletion = deleteOriginalDevicePhotos( ["ph://ONE"] );
      await jest.advanceTimersByTimeAsync( 5000 );

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
