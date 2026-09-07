import { Alert, AppState } from "react-native";
import promptDeleteOriginalDevicePhotos, {
  deleteOriginalDevicePhotos,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  forgetUnansweredDeleteState,
  quarantinedAssetIds,
  suspectAssetIds,
} from "sharedHelpers/unansweredDeleteAssets";
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
    // Persisted in MMKV and deliberately outliving a launch, so it outlives a
    // test too unless it is cleared.
    forgetUnansweredDeleteState( );
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
          ms: 4800,
          backgrounded: false,
          wentInactive: false,
          appStateChanges: 0,
        } ),
      );
      const [, extra] = mockLogger.errorWithExtra.mock.calls[0];
      // Counted for the whole session, so other hangs in this file add to it.
      expect( extra.hangsThisSession ).toBeGreaterThanOrEqual( 1 );
      expect( JSON.stringify( extra ) ).not.toContain( "ph://" );
    } );

    it( "opens a whole-library delete small and then runs at full size", async ( ) => {
      // A transaction is all or nothing, so one asset PhotoKit won't answer for
      // blocks every photo batched with it. Chunking is what makes each answer
      // mean something; the small first chunks keep what an early hang costs
      // down, in both suspects to search and photos left undeleted.
      mockDeletePhotos.mockResolvedValue( { deleted: 25, requested: 25 } );
      const uris = Array.from( { length: 500 }, ( _unused, i ) => `ph://R${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      ).toEqual( [25, 50, 100, 200, 125] );
      expect( result ).toMatchObject( { requested: 500, succeeded: true } );
    } );

    it( "makes the assets of a transaction that never answered the suspects", async ( ) => {
      // The only instrument that can tell an unanswerable asset from an
      // ordinary one is which transactions come back, so a transaction the
      // native watchdog gave up on narrows the search to its own assets.
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://S${i}` );

      await deleteOriginalDevicePhotos( uris );

      expect( suspectAssetIds( ) ).toHaveLength( 25 );
      expect( suspectAssetIds( ) ).toContain( "S0" );
      // The chunks behind the one that hung were never issued, so their photos
      // are not under suspicion.
      expect( suspectAssetIds( ) ).not.toContain( "S250" );
    } );

    it( "halves the suspects each cleanup and deletes everything else", async ( ) => {
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://H${i}` );
      await deleteOriginalDevicePhotos( uris );
      expect( suspectAssetIds( ) ).toHaveLength( 25 );

      // Next cleanup: the 275 that were never suspect delete normally, and one
      // half of the suspects goes out last to halve the search.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 25, requested: 25 } );
      await deleteOriginalDevicePhotos( uris );

      const sent = mockDeletePhotos.mock.calls.map( call => call[0] );
      expect( sent.reduce( ( n, chunk ) => n + chunk.length, 0 ) ).toEqual( 275 + 13 );
      // The ordinary photos first, the suspect probe last.
      expect( sent[0] ).toContain( "ph://H25" );
      expect( sent.at( -1 ) ).toHaveLength( 13 );
      expect( sent.at( -1 ) ).toContain( "ph://H0" );
      // That probe came back, so the asset that hangs is in the half held back.
      expect( suspectAssetIds( ) ).toHaveLength( 12 );
      expect( suspectAssetIds( ) ).not.toContain( "H0" );
    } );

    it( "quarantines the asset once it is the only one left under suspicion", async ( ) => {
      // Alone in a transaction that never came back, it is proven — so it stops
      // being sent at all rather than taking a thousand photos down with it.
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://BAD"] );

      expect( quarantinedAssetIds( ) ).toEqual( ["BAD"] );
      expect( suspectAssetIds( ) ).toEqual( [] );

      // A later cleanup leaves it out and says so, instead of hanging on it.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      const result = await deleteOriginalDevicePhotos( ["ph://BAD", "ph://GOOD"] );

      expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://GOOD"] );
      expect( result ).toMatchObject( { requested: 2, deleted: 1, quarantined: 1 } );
    } );

    it( "narrows to the last suspect but accuses it on its own evidence", async ( ) => {
      // Two suspects, one of which just deleted. The other is not quarantined
      // for being last: a transaction can be recorded unanswered while it is
      // only slow, and a set built from one of those holds nothing wrong. It
      // goes out alone next time and is judged on that.
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2"] );
      expect( suspectAssetIds( ) ).toEqual( ["P1", "P2"] );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2"] );
      expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://P1"] );
      expect( suspectAssetIds( ) ).toEqual( ["P2"] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );

      // Alone in a transaction that never comes back, it is proven.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://P2"] );
      expect( quarantinedAssetIds( ) ).toEqual( ["P2"] );
    } );

    it( "ends the search accusing nobody when every suspect deletes", async ( ) => {
      // A transaction recorded unanswered can still have been merely slow, so
      // the suspect set is not proof that anything is wrong with it.
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://Q1", "ph://Q2"] );
      expect( suspectAssetIds( ) ).toEqual( ["Q1", "Q2"] );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      await deleteOriginalDevicePhotos( ["ph://Q1", "ph://Q2"] );
      await deleteOriginalDevicePhotos( ["ph://Q1", "ph://Q2"] );

      expect( suspectAssetIds( ) ).toEqual( [] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "gives a chunked delete a transaction's budget per chunk", async ( ) => {
      // A transaction costs ~1.6s whatever it holds, so the hang report waits
      // one transaction's worth per chunk rather than firing while the second
      // chunk is legitimately still going.
      let failDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( ( _resolve, reject ) => { failDeletion = reject; } ),
      );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://R${i}` );

      // 300 photos are four transactions (25, 50, 100, 125), so the report is
      // owed four transactions' worth of time before it calls this a hang.
      const deletion = deleteOriginalDevicePhotos( uris );
      await jest.advanceTimersByTimeAsync( 9000 );
      expect( mockLogger.errorWithExtra ).not.toHaveBeenCalledWith(
        "photo_delete_pending",
        expect.anything( ),
      );

      await jest.advanceTimersByTimeAsync( 2000 );
      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_pending",
        expect.objectContaining( { requested: 300 } ),
      );

      // The first chunk is the only one ever issued: a chunk the library has
      // not answered stops the run rather than stacking the next transaction on
      // it. Fail it the way the native watchdog eventually does, so the write
      // chain is released for the tests that follow.
      expect( mockDeletePhotos ).toHaveBeenCalledTimes( 1 );
      failDeletion( new Error( "deleteAssets never called back" ) );
      await deletion;
      await jest.advanceTimersByTimeAsync( 0 );
    } );

    it( "keeps the photos a landed chunk deleted when a later chunk fails", async ( ) => {
      // A cleanup that got most of the way is not a failed one. Reporting zero
      // deleted when 200 photos are gone is what made a working cleanup and a
      // dead one look the same in the log.
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 25, requested: 25 } )
        .mockRejectedValueOnce( new Error( "deleteAssets never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://F${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect( result ).toMatchObject( {
        deleted: 25, requested: 300, succeeded: false,
      } );
      // 25 of their photos are gone, so they are not told nothing happened.
      expect( Alert.alert ).not.toHaveBeenCalled( );
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
        deleted: 0, requested: 1, succeeded: false, pending: true, quarantined: 0,
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
      expect( await next ).toEqual( {
        deleted: 1, requested: 1, succeeded: true, undeletable: 0, quarantined: 0,
      } );
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
