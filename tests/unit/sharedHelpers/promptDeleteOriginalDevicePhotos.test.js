import { Alert, AppState } from "react-native";
import promptDeleteOriginalDevicePhotos, {
  deleteOriginalDevicePhotos,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  forgetUnansweredDeleteState,
  maxTransactionSize,
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
  warnWithExtra: jest.fn( ),
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
      warnWithExtra: ( ...args ) => mockLogger.warnWithExtra( ...args ),
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

    it( "ramps a whole-library delete up to the cap", async ( ) => {
      mockDeletePhotos.mockResolvedValue( { deleted: 200, requested: 200 } );
      const uris = Array.from( { length: 500 }, ( _unused, i ) => `ph://R${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      ).toEqual( [1, 5, 25, 50, 100, 200, 119] );
      expect( result ).toMatchObject( { requested: 500, succeeded: true } );
    } );

    it( "halves the cap when the library leaves a transaction unanswered", async ( ) => {
      // Nothing smaller than 166 assets has ever been tried on the device this
      // is failing on, because every chunking attempt put a full chunk first.
      // A cleanup that dies at 200 comes back at 100, then 50, closing in on a
      // size the library will still answer.
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 1, requested: 1 } )
        .mockResolvedValueOnce( { deleted: 5, requested: 5 } )
        .mockResolvedValueOnce( { deleted: 25, requested: 25 } )
        .mockResolvedValueOnce( { deleted: 50, requested: 50 } )
        .mockResolvedValueOnce( { deleted: 100, requested: 100 } )
        .mockRejectedValueOnce( new Error( "never called back" ) );
      const uris = Array.from( { length: 600 }, ( _unused, i ) => `ph://C${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      ).toEqual( [1, 5, 25, 50, 100, 200] );
      // The ramp's photos are deleted even though the run ended on a hang.
      expect( result ).toMatchObject( { deleted: 181, requested: 600 } );
      expect( maxTransactionSize( ) ).toEqual( 100 );

      // Next cleanup opens at one again and asks for no more than the library
      // has shown it will take.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      await deleteOriginalDevicePhotos( uris );
      const sizes = mockDeletePhotos.mock.calls.map( call => call[0].length );
      expect( sizes[0] ).toEqual( 1 );
      expect( Math.max( ...sizes ) ).toEqual( 100 );
    } );

    it( "opens at a single photo so the smallest transaction is tried first", async ( ) => {
      // The one single-asset deletion in the log was issued 40ms before an
      // ErrorBoundary reloaded the bundle out from under it, so it says nothing
      // about size. This is the first honest test of one.
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );

      await deleteOriginalDevicePhotos(
        Array.from( { length: 600 }, ( _unused, i ) => `ph://O${i}` ),
      );

      expect( mockDeletePhotos.mock.calls[0][0] ).toHaveLength( 1 );
      // A transaction of one that goes unanswered leaves nowhere further to
      // close in on, and the question is settled.
      expect( maxTransactionSize( ) ).toEqual( 1 );
    } );

    it( "lets the cap grow back once the library answers at it", async ( ) => {
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://G1"] );
      expect( maxTransactionSize( ) ).toEqual( 1 );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      await deleteOriginalDevicePhotos( ["ph://G2"] );

      expect( maxTransactionSize( ) ).toEqual( 2 );
    } );

    it( "makes the assets of a transaction that never answered the suspects", async ( ) => {
      // The only instrument that can tell an unanswerable asset from an
      // ordinary one is which transactions come back, so a transaction the
      // native watchdog gave up on narrows the search to its own assets.
      // The opening transaction of one comes back, so the first that doesn't
      // is the five behind it, and those are the suspects.
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 1, requested: 1 } )
        .mockRejectedValue( new Error( "never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://S${i}` );

      await deleteOriginalDevicePhotos( uris );

      expect( suspectAssetIds( ) ).toEqual( ["S1", "S2", "S3", "S4", "S5"] );
      // The chunks behind the one that hung were never issued, so their photos
      // are not under suspicion.
      expect( suspectAssetIds( ) ).not.toContain( "S250" );
      // Nothing is accused: a transaction that hung because of its size says
      // nothing about any asset in it.
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "halves the suspects each cleanup and deletes everything else", async ( ) => {
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 1, requested: 1 } )
        .mockRejectedValueOnce( new Error( "never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://H${i}` );
      await deleteOriginalDevicePhotos( uris );
      expect( suspectAssetIds( ) ).toEqual( ["H1", "H2", "H3", "H4", "H5"] );

      // Next cleanup: everything that was never suspect deletes normally, and
      // half of the suspects goes out last to halve the search.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      await deleteOriginalDevicePhotos( uris );

      const sent = mockDeletePhotos.mock.calls.map( call => call[0] );
      expect( sent.at( -1 ) ).toEqual( ["ph://H1", "ph://H2", "ph://H3"] );
      // That probe came back, so anything unanswerable is in the half held back.
      expect( suspectAssetIds( ) ).toEqual( ["H4", "H5"] );
    } );

    it( "quarantines the asset once it is the only one left under suspicion", async ( ) => {
      // Hung once in the transaction that put it under suspicion, and again
      // sent alone as the probe narrowing that suspicion. That is evidence
      // about the asset rather than about the size — every cleanup now opens
      // with a transaction of one, and accusing that photo whenever the run
      // failed would blame a different innocent one each time.
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://BAD"] );
      expect( suspectAssetIds( ) ).toEqual( ["BAD"] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );

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
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2", "ph://P3"] );
      expect( suspectAssetIds( ) ).toEqual( ["P1", "P2", "P3"] );

      // Half of them go out as the probe and come back, so the other half is
      // what is left to explain.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 2, requested: 2 } );
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2", "ph://P3"] );
      expect( suspectAssetIds( ) ).toEqual( ["P3"] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );

      // Alone as the probe, in a transaction that never comes back: proven.
      // Only the suspect is left to delete by now, so the probe is the whole
      // cleanup -- while ordinary chunks are still hanging the probe is never
      // reached, which is right, because then the trouble isn't one asset.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://P3"] );
      expect( quarantinedAssetIds( ) ).toEqual( ["P3"] );
    } );

    it( "ends the search accusing nobody when every suspect deletes", async ( ) => {
      // A transaction recorded unanswered can still have been merely slow, so
      // the suspect set is not proof that anything is wrong with it.
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( ["ph://Q0", "ph://Q1", "ph://Q2"] );
      expect( suspectAssetIds( ) ).toEqual( ["Q0", "Q1", "Q2"] );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockResolvedValue( { deleted: 2, requested: 2 } );
      await deleteOriginalDevicePhotos( ["ph://Q0", "ph://Q1", "ph://Q2"] );
      await deleteOriginalDevicePhotos( ["ph://Q0", "ph://Q1", "ph://Q2"] );

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

      // 300 photos ramp into six transactions (1, 5, 25, 50, 100, 119), so the
      // report is owed six transactions' worth of time before it calls this a
      // hang.
      const deletion = deleteOriginalDevicePhotos( uris );
      await jest.advanceTimersByTimeAsync( 12000 );
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
        .mockResolvedValueOnce( { deleted: 200, requested: 200 } )
        .mockRejectedValueOnce( new Error( "deleteAssets never called back" ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://F${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect( result ).toMatchObject( {
        deleted: 200, requested: 300, succeeded: false,
      } );
      // 200 of their photos are gone, so they are not told nothing happened.
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
