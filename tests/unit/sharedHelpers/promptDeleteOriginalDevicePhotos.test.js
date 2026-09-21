import { Alert, AppState } from "react-native";
import promptDeleteOriginalDevicePhotos, {
  deleteOriginalDevicePhotos,
} from "sharedHelpers/promptDeleteOriginalDevicePhotos";
import {
  beginDeleteTransaction,
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
const mockAddAssetsToAlbum = jest.fn(
  async uris => ( { added: uris.length, requested: uris.length, alreadyIn: 0 } ),
);

// The module under test destructures NativeModules.ImageCropper at import time,
// so the native helper has to exist before that import runs. deletePhotoAssets
// is left off, keeping the deletion itself on the CameraRoll fallback the other
// tests drive.
jest.mock( "react-native", ( ) => {
  const RN = jest.requireActual( "react-native" );
  RN.NativeModules.ImageCropper = {
    photoDeletionContext: ( ...args ) => mockPhotoDeletionContext( ...args ),
    addAssetsToAlbum: ( ...args ) => mockAddAssetsToAlbum( ...args ),
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
    mockAddAssetsToAlbum.mockReset( );
    mockAddAssetsToAlbum.mockImplementation(
      async uris => ( { added: uris.length, requested: uris.length, alreadyIn: 0 } ),
    );
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

    it( "files the photos into the album after the deletion has had its go", async ( ) => {
      // Deleting these from the Photos app works on the device where the app's
      // own deletions don't, so the album is what the user is left with when
      // the deletion goes nowhere. It has to be filed afterwards: a deleted
      // asset leaves every album it is in, so filing first emptied the album
      // again on every cleanup that worked.
      mockDeletePhotos.mockRejectedValue( new Error( "never called back" ) );

      await deleteOriginalDevicePhotos( ["ph://ONE", "ph://TWO"] );
      await jest.advanceTimersByTimeAsync( 0 );

      expect( mockAddAssetsToAlbum ).toHaveBeenCalledWith(
        ["ph://ONE", "ph://TWO"],
        "Imported to iNaturalist",
      );
      expect( mockAddAssetsToAlbum.mock.invocationCallOrder[0] )
        .toBeGreaterThan( mockDeletePhotos.mock.invocationCallOrder[0] );
    } );

    it( "deletes even when the photos could not be filed", async ( ) => {
      // A photo that isn't in the album is a smaller problem than a cleanup
      // that refused to run because the filing failed.
      mockAddAssetsToAlbum.mockRejectedValue( new Error( "no album" ) );
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );

      const result = await deleteOriginalDevicePhotos( ["ph://ONE"] );

      expect( mockDeletePhotos ).toHaveBeenCalledWith( ["ph://ONE"] );
      expect( result ).toMatchObject( { deleted: 1, succeeded: true } );
    } );

    // The native watchdog gave up waiting for a consent alert nobody tapped.
    const unanswered = ( ) => Object.assign(
      new Error( "deleteAssets for 200 asset(s) never called back in 150s" ),
      { code: "DELETE_NO_CALLBACK" },
    );
    // The user tapped Don't Allow.
    const declined = ( ) => Object.assign(
      new Error(
        "requested=200 fetched=200 error=The operation couldn't be completed. "
        + "(PHPhotosErrorDomain error 3072.)",
      ),
      { code: "DELETE_FAILED" },
    );
    // A refusal the library itself made.
    const refused = ( ) => Object.assign(
      new Error( "error=The operation couldn't be completed. (PHPhotosErrorDomain error 3311.)" ),
      { code: "DELETE_FAILED" },
    );

    it( "sends groups of ten, doubling, up to the cap", async ( ) => {
      // One transaction is one consent alert, so the number of groups is the
      // number of times the cleanup asks. Opening at ten risks ten photos
      // rather than two hundred on the first ask, and doubling reaches the cap
      // in five steps so the tail still goes out full-sized.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockImplementation( async uris => (
        { deleted: uris.length, requested: uris.length }
      ) );
      const uris = Array.from( { length: 500 }, ( _unused, i ) => `ph://R${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      ).toEqual( [10, 20, 40, 80, 160, 190] );
      expect( result ).toMatchObject( { requested: 500, succeeded: true } );
    } );

    it( "sends a small delete in one group rather than splitting it", async ( ) => {
      // Fifteen photos is one ask of ten and one of five, and six photos is a
      // single ask: the ramp never asks more times than there are photos for.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockImplementation( async uris => (
        { deleted: uris.length, requested: uris.length }
      ) );

      await deleteOriginalDevicePhotos(
        Array.from( { length: 6 }, ( _unused, i ) => `ph://X${i}` ),
      );

      expect( mockDeletePhotos.mock.calls.map( call => call[0].length ) ).toEqual( [6] );
    } );

    it( "leaves the cap alone when a consent alert goes unanswered", async ( ) => {
      // This is what collapsed the cap to one photo a transaction. A
      // transaction the watchdog gave up on is an alert nobody tapped, and
      // halving for it makes the next cleanup ask more times, so fewer get
      // answered and it halves again.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockRejectedValue( unanswered( ) );

      await deleteOriginalDevicePhotos(
        Array.from( { length: 600 }, ( _unused, i ) => `ph://U${i}` ),
      );

      expect( maxTransactionSize( ) ).toEqual( 200 );
      expect( suspectAssetIds( ) ).toEqual( [] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "leaves the cap alone when the user declines", async ( ) => {
      // Declining says something about this deletion, not about the library.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockRejectedValue( declined( ) );

      await deleteOriginalDevicePhotos(
        Array.from( { length: 600 }, ( _unused, i ) => `ph://D${i}` ),
      );

      expect( maxTransactionSize( ) ).toEqual( 200 );
      expect( suspectAssetIds( ) ).toEqual( [] );
    } );

    it( "recovers a cap that collapsed under the old halving", async ( ) => {
      // Every phone that ran those builds is carrying a stored cap of one, and
      // at one photo per alert a 326-photo cleanup asks 326 times. Clamped on
      // read, so the next cleanup is two alerts instead.
      forgetUnansweredDeleteState( 1 );

      expect( maxTransactionSize( ) ).toEqual( 100 );

      mockDeletePhotos.mockImplementation( async uris => (
        { deleted: uris.length, requested: uris.length }
      ) );
      await deleteOriginalDevicePhotos(
        Array.from( { length: 326 }, ( _unused, i ) => `ph://L${i}` ),
      );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      // Clamped up to 100, and the ramp climbs toward it: six alerts, not 326.
      ).toEqual( [10, 20, 40, 80, 100, 76] );
    } );

    it( "halves the cap on a refusal the library actually made, down to the floor", async ( ) => {
      forgetUnansweredDeleteState( );
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 10, requested: 10 } )
        .mockResolvedValueOnce( { deleted: 20, requested: 20 } )
        .mockResolvedValueOnce( { deleted: 40, requested: 40 } )
        .mockResolvedValueOnce( { deleted: 80, requested: 80 } )
        .mockResolvedValueOnce( { deleted: 160, requested: 160 } )
        .mockRejectedValueOnce( refused( ) );
      const uris = Array.from( { length: 600 }, ( _unused, i ) => `ph://F${i}` );

      const result = await deleteOriginalDevicePhotos( uris );

      expect(
        mockDeletePhotos.mock.calls.map( call => call[0].length ),
      ).toEqual( [10, 20, 40, 80, 160, 200] );
      expect( result ).toMatchObject( { deleted: 310, requested: 600 } );
      // Halved once, and then held: below the floor a cleanup needs more
      // alerts than anyone will answer.
      expect( maxTransactionSize( ) ).toEqual( 100 );
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockRejectedValue( refused( ) );
      await deleteOriginalDevicePhotos( uris );
      expect( maxTransactionSize( ) ).toEqual( 100 );
    } );

    it( "does not read a transaction left open by a run that was deleting fine", async ( ) => {
      // A record still in the store on the next launch is only evidence when
      // it is bigger than the transactions that same run had already had
      // answered. Otherwise the process died -- the app killed in the
      // background, the user force-quitting a long cleanup -- and reading it
      // as a hang halves the cap and accuses an innocent photo every launch,
      // which is what held this device at one photo a transaction for days.
      forgetUnansweredDeleteState( );
      beginDeleteTransaction( ["ph://LIVE1", "ph://LIVE2"], 100 );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockImplementation( async uris => (
        { deleted: uris.length, requested: uris.length }
      ) );
      await deleteOriginalDevicePhotos( ["ph://NEXT"] );

      expect( maxTransactionSize( ) ).toEqual( 200 );
      expect( suspectAssetIds( ) ).toEqual( [] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "still reads a transaction bigger than anything its run had answered", async ( ) => {
      forgetUnansweredDeleteState( );
      beginDeleteTransaction( ["ph://H1", "ph://H2", "ph://H3", "ph://H4"], 2 );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockImplementation( async uris => (
        { deleted: uris.length, requested: uris.length }
      ) );
      await deleteOriginalDevicePhotos( ["ph://NEXT"] );

      expect( suspectAssetIds( ) ).toEqual( ["H1", "H2", "H3", "H4"] );
    } );

    it( "makes the assets of a transaction the library refused the suspects", async ( ) => {
      // The only instrument that can tell an unanswerable asset from an
      // ordinary one is which transactions come back, so a transaction the
      // library refuses narrows the search to its own assets. An alert nobody
      // answered is not one of those -- see the two tests above.
      forgetUnansweredDeleteState( );
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 10, requested: 10 } )
        .mockRejectedValue( refused( ) );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://S${i}` );

      await deleteOriginalDevicePhotos( uris );

      // The opening group of ten came back, so the refused one is the twenty
      // behind it, and those are the suspects.
      expect( suspectAssetIds( ) ).toHaveLength( 20 );
      expect( suspectAssetIds( ) ).toContain( "S10" );
      expect( suspectAssetIds( ) ).not.toContain( "S0" );
      // Nothing is accused: a transaction refused for its size says nothing
      // about any asset in it.
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "sends the suspects in halving transactions rather than holding half back", async ( ) => {
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockRejectedValueOnce( refused( ) );
      const uris = ["ph://H0", "ph://H1", "ph://H2"];
      await deleteOriginalDevicePhotos( uris );
      expect( suspectAssetIds( ) ).toEqual( ["H0", "H1", "H2"] );

      // Next cleanup: the suspects go out a halving transaction at a time.
      // Every one of them is asked for -- a photo the user is looking at in
      // the cleanup grid is never silently left out of the delete they
      // pressed.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockImplementation( async sent => (
        { deleted: sent.length, requested: sent.length }
      ) );
      await deleteOriginalDevicePhotos( uris );

      expect( mockDeletePhotos.mock.calls.map( call => call[0] ) ).toEqual( [
        ["ph://H0", "ph://H1"],
        ["ph://H2"],
      ] );
      // They all came back, so there is nothing left to explain.
      expect( suspectAssetIds( ) ).toEqual( [] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "narrows to the transaction that hung when one of the halves does", async ( ) => {
      // The narrowing is what the halving is for: the chunk the library never
      // answers becomes the suspect set, and the run stops there rather than
      // issuing another transaction at a wedged photolibraryd.
      mockDeletePhotos.mockRejectedValueOnce( new Error( "never called back" ) );
      const uris = Array.from( { length: 8 }, ( _unused, i ) => `ph://N${i}` );
      await deleteOriginalDevicePhotos( uris );
      expect( suspectAssetIds( ) ).toEqual(
        ["N0", "N1", "N2", "N3", "N4", "N5", "N6", "N7"],
      );

      // The cap is 4 after that hang, so the eight go out as 4, 2, 1, 1. The
      // half answers, the quarter behind it doesn't, and the search is down to
      // that quarter.
      mockDeletePhotos.mockReset( );
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 4, requested: 4 } )
        .mockRejectedValueOnce( new Error( "never called back" ) );
      await deleteOriginalDevicePhotos( uris );

      expect( mockDeletePhotos.mock.calls.map( call => call[0].length ) ).toEqual( [4, 2] );
      expect( suspectAssetIds( ) ).toEqual( ["N4", "N5"] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
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
      // Three suspects, two of which just deleted. The last is not quarantined
      // for being last: a transaction can be recorded unanswered while it is
      // only slow, and a set built from one of those holds nothing wrong. It
      // goes out alone and is judged on that -- in this same cleanup now,
      // rather than one cleanup per halving.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockRejectedValueOnce( refused( ) );
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2", "ph://P3"] );
      expect( suspectAssetIds( ) ).toEqual( ["P1", "P2", "P3"] );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos
        .mockResolvedValueOnce( { deleted: 2, requested: 2 } )
        .mockRejectedValue( refused( ) );
      await deleteOriginalDevicePhotos( ["ph://P1", "ph://P2", "ph://P3"] );

      // Alone as the probe, in a transaction that never comes back: proven.
      expect( quarantinedAssetIds( ) ).toEqual( ["P3"] );
      expect( suspectAssetIds( ) ).toEqual( [] );
      // The first refusal put the cap on the floor and the probe left it
      // there: the asset is the explanation, so the size is not, and a photo
      // the library refuses on its own must not shrink later cleanups further.
      expect( maxTransactionSize( ) ).toEqual( 100 );
    } );

    it( "ends the search accusing nobody when every suspect deletes", async ( ) => {
      // A transaction recorded unanswered can still have been merely slow, so
      // the suspect set is not proof that anything is wrong with it.
      forgetUnansweredDeleteState( );
      mockDeletePhotos.mockRejectedValueOnce( refused( ) );
      await deleteOriginalDevicePhotos( ["ph://Q0", "ph://Q1", "ph://Q2"] );
      expect( suspectAssetIds( ) ).toEqual( ["Q0", "Q1", "Q2"] );

      mockDeletePhotos.mockReset( );
      mockDeletePhotos.mockImplementation( async sent => (
        { deleted: sent.length, requested: sent.length }
      ) );
      const result = await deleteOriginalDevicePhotos( ["ph://Q0", "ph://Q1", "ph://Q2"] );

      // One cleanup, not three: every suspect was asked for, so the photos the
      // user was looking at are all gone and the search is over.
      expect( result ).toMatchObject( { deleted: 3, requested: 3, succeeded: true } );
      expect( suspectAssetIds( ) ).toEqual( [] );
      expect( quarantinedAssetIds( ) ).toEqual( [] );
    } );

    it( "gives a chunked delete a transaction's budget per chunk", async ( ) => {
      // A transaction costs ~1.6s whatever it holds, so the hang report waits
      // one transaction's worth per chunk rather than firing while the second
      // chunk is legitimately still going.
      forgetUnansweredDeleteState( );
      let failDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( ( _resolve, reject ) => { failDeletion = reject; } ),
      );
      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://R${i}` );

      // 300 photos go out as five groups (10, 20, 40, 80, 150), so the report
      // is owed five transactions' worth of time before it calls this a hang.
      const deletion = deleteOriginalDevicePhotos( uris );
      await jest.advanceTimersByTimeAsync( 11000 );
      expect( mockLogger.errorWithExtra ).not.toHaveBeenCalledWith(
        "photo_delete_pending",
        expect.anything( ),
      );

      await jest.advanceTimersByTimeAsync( 1500 );
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

    it( "describes the transaction that hung, not the whole cleanup", async ( ) => {
      // Chunks go out one at a time, so what PhotoKit is holding is one chunk.
      // Describing the whole request instead is why five weeks of hangs never
      // named the photos in them: the Sep 21 log reports one asset outstanding
      // and then dumps the first eight of 326, none of which need be it.
      forgetUnansweredDeleteState( );
      mockPhotoDeletionContext.mockResolvedValue( "transaction=active count=10" );
      let finishDeletion;
      mockDeletePhotos.mockImplementation(
        ( ) => new Promise( resolve => { finishDeletion = resolve; } ),
      );

      const uris = Array.from( { length: 300 }, ( _unused, i ) => `ph://D${i}` );
      const pending = deleteOriginalDevicePhotos( uris );
      await jest.advanceTimersByTimeAsync( 13000 );

      // The opening group of ten, which is what never came back -- not all 300.
      expect( mockPhotoDeletionContext ).toHaveBeenCalledWith( uris.slice( 0, 10 ) );
      expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
        "photo_delete_pending",
        expect.objectContaining( {
          requested: 300,
          outstandingChunk: 0,
          outstandingAssets: 10,
          outstandingIsProbe: false,
        } ),
      );

      // Let the abandoned transaction settle rather than leaving it holding the
      // write chain against whatever runs next.
      mockDeletePhotos.mockResolvedValue( { deleted: 1, requested: 1 } );
      finishDeletion( { deleted: 1, requested: 1 } );
      await jest.advanceTimersByTimeAsync( 30000 );
      await pending;
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
