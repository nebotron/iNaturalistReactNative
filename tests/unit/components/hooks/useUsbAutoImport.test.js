import { renderHook } from "@testing-library/react-native";
import useUsbAutoImport from "components/hooks/useUsbAutoImport";
import { enqueuePhotoLibraryWrite } from "sharedHelpers/promptDeleteOriginalDevicePhotos";

const mockListNewUsbImages = jest.fn( );
const mockSaveUsbImageToPhotos = jest.fn( );
const mockMarkUsbImagesImported = jest.fn( );
const mockDeleteUsbSourceImages = jest.fn( async ( ) => ( { deleted: 0, failed: 0 } ) );
const mockClearUsbOffloadMarker = jest.fn( );
const mockMarkUsbOffloadStarted = jest.fn( );
const mockTakeUnfinishedUsbOffload = jest.fn( ( ) => null );
const mockUpdateUsbOffloadProgress = jest.fn( );
const mockGetUsbFolderName = jest.fn( );
const mockGetUsbFolderDiagnostics = jest.fn( );

jest.mock( "sharedHelpers/usbStorage", ( ) => ( {
  availableMemoryMb: ( ) => 512,
  refreshAvailableMemory: ( ) => undefined,
  clearUsbOffloadMarker: ( ) => mockClearUsbOffloadMarker( ),
  deleteUsbSourceImages: ( ...args ) => mockDeleteUsbSourceImages( ...args ),
  getUsbFolderDiagnostics: ( ) => mockGetUsbFolderDiagnostics( ),
  getUsbFolderName: ( ) => mockGetUsbFolderName( ),
  isUsbImportSupported: ( ) => true,
  listNewUsbImages: ( ...args ) => mockListNewUsbImages( ...args ),
  markUsbImagesImported: ( ...args ) => mockMarkUsbImagesImported( ...args ),
  markUsbOffloadStarted: ( ...args ) => mockMarkUsbOffloadStarted( ...args ),
  requestUsbPhotosPermission: async ( ) => "authorized",
  saveUsbImageToPhotos: ( ...args ) => mockSaveUsbImageToPhotos( ...args ),
  takeUnfinishedUsbOffload: ( ) => mockTakeUnfinishedUsbOffload( ),
  updateUsbOffloadProgress: ( ...args ) => mockUpdateUsbOffloadProgress( ...args ),
} ) );

jest.mock( "sharedHelpers/installData", ( ) => ( {
  useOnboardingShown: ( ) => [true],
} ) );

jest.mock( "sharedHelpers/backgroundExecution", ( ) => ( {
  beginBackgroundUsbImportTask: async ( ) => false,
  endBackgroundUsbImportTask: async ( ) => undefined,
} ) );

const mockLogger = {
  info: jest.fn( ), debug: jest.fn( ), error: jest.fn( ), errorWithExtra: jest.fn( ),
};
jest.mock( "sharedHelpers/logger", ( ) => ( {
  log: {
    extend: ( ) => ( {
      info: ( ...args ) => mockLogger.info( ...args ),
      // eslint-disable-next-line testing-library/no-debugging-utils
      debug: ( ...args ) => mockLogger.debug( ...args ),
      error: ( ...args ) => mockLogger.error( ...args ),
      errorWithExtra: ( ...args ) => mockLogger.errorWithExtra( ...args ),
    } ),
  },
} ) );

const images = n => Array.from(
  { length: n },
  ( _unused, i ) => ( { relativePath: `IMG_${i}.CR3` } ),
);

describe( "useUsbAutoImport", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    jest.useFakeTimers( );
    mockGetUsbFolderName.mockResolvedValue( "101EOSR7" );
    mockGetUsbFolderDiagnostics.mockResolvedValue( { bookmarkPresent: true } );
    mockListNewUsbImages.mockResolvedValue( {
      available: true,
      images: images( 40 ),
      imageFileCount: 40,
      alreadyImportedCount: 0,
      knownCount: 0,
      regularFileCount: 40,
      extensions: { cr3: 40 },
    } );
  } );
  afterEach( ( ) => jest.useRealTimers( ) );

  // A wedged Photos library makes every save burn the full 30s timeout in
  // turn. Left to run, a 122-photo card is an hour of grinding to save
  // nothing, plus an error line per file in the remote log.
  it( "abandons the run after a run of Photos-library save timeouts", async ( ) => {
    mockSaveUsbImageToPhotos.mockImplementation( ( ) => new Promise( ( ) => {} ) );

    renderHook( ( ) => useUsbAutoImport( ) );
    // Three 30s save timeouts, then the fourth file is never attempted.
    await jest.advanceTimersByTimeAsync( 4 * 30_000 );

    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 3 );
    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_library_wedged",
      expect.objectContaining( { abandoned: 37, saved: 0, failed: 3 } ),
    );
  } );

  // The Aug 12 offload sat for 4h9m having saved 0 of 21 and logged nothing:
  // the 30s timeout only covers the native save once the shared Photos-library
  // write chain reaches this file, and the wait for the chain itself had no
  // bound at all. A write queued ahead that never settles must not park the
  // whole run.
  it( "gives up when the Photos-library write chain never reaches it", async ( ) => {
    let releaseChain = ( ) => {};
    enqueuePhotoLibraryWrite( ( ) => new Promise( resolve => { releaseChain = resolve; } ) );
    mockSaveUsbImageToPhotos.mockResolvedValue( { localIdentifier: "asset" } );

    renderHook( ( ) => useUsbAutoImport( ) );
    // Three files that never get their turn, at 200s each.
    await jest.advanceTimersByTimeAsync( 3 * 200_000 );

    // The saves never started: the run gave up waiting rather than hanging.
    expect( mockSaveUsbImageToPhotos ).not.toHaveBeenCalled( );
    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_library_wedged",
      expect.objectContaining( { saved: 0, failed: 3 } ),
    );

    // Don't leave the chain blocked for the rest of the file.
    releaseChain( );
    await jest.advanceTimersByTimeAsync( 0 );
  } );

  // Every log line is a network POST, so a run the app dies inside takes its
  // last lines with it. The Aug 5 19:08–20:22 log has two offloads of the same
  // 80 files, each followed within a minute by a cold pickup and neither by an
  // outcome line, and nothing said how far either got. The marker is MMKV, so
  // it survives the death it is measuring.
  it( "reports an offload the app never came back from", async ( ) => {
    mockTakeUnfinishedUsbOffload.mockReturnValueOnce( {
      total: 80,
      saved: 12,
      failed: 1,
      startedAt: Date.now( ) - 44_000,
      lastProgressAt: Date.now( ) - 30_000,
      phase: "saving 13/80",
      appState: "background",
      availableMemoryMb: 96,
    } );
    mockSaveUsbImageToPhotos.mockResolvedValue( { localIdentifier: "x" } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    // Where it stopped and what the app was doing there: a native call that
    // wedges leaves the app active, iOS suspending the process does not.
    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_never_finished",
      expect.objectContaining( {
        total: 80,
        saved: 12,
        failed: 1,
        msSinceProgress: 30_000,
        phase: "saving 13/80",
        appStateAtLastProgress: "background",
        availableMemoryMbAtLastProgress: 96,
      } ),
    );
    // The run that did finish clears its own marker rather than leaving one
    // for the next scan to report.
    expect( mockClearUsbOffloadMarker ).toHaveBeenCalled( );
  } );

  it( "says nothing when the previous offload finished", async ( ) => {
    mockSaveUsbImageToPhotos.mockResolvedValue( { localIdentifier: "x" } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    expect( mockMarkUsbOffloadStarted ).toHaveBeenCalledWith( 40 );
    expect( mockLogger.errorWithExtra ).not.toHaveBeenCalledWith(
      "usb_offload_never_finished",
      expect.anything( ),
    );
  } );

  it( "does not pick the same card up again on the next scan", async ( ) => {
    mockSaveUsbImageToPhotos.mockImplementation( ( ) => new Promise( ( ) => {} ) );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 4 * 30_000 );
    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 3 );

    // Several more 10s scan intervals: nothing recovers a wedged library on
    // that timescale, so retrying just repeats the same three timeouts.
    await jest.advanceTimersByTimeAsync( 60_000 );
    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 3 );
  } );

  // This is the run that most needs explaining, and it was the one run that
  // logged no outcome at all: the summary used to sit inside "if anything
  // saved", so the Aug 5 log couldn't say whether the offload finished or the
  // app died holding it.
  it( "reports the outcome of a run where nothing saved", async ( ) => {
    mockSaveUsbImageToPhotos.mockRejectedValue( new Error( "unreadable file" ) );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    expect( mockDeleteUsbSourceImages ).not.toHaveBeenCalled( );
    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_saves_failing",
      expect.objectContaining( { saved: 0, failed: 3, abandoned: 37 } ),
    );
  } );

  // The Aug 6 log: the phone ran out of room, so every copy failed instantly
  // instead of timing out, the timeouts-only counter reset on each one, and the
  // run ground through all 157 files in a second and a half — then the poll did
  // it again ten seconds later. 1,084 error lines in 74 seconds.
  it( "abandons the run as soon as the device is out of space", async ( ) => {
    mockSaveUsbImageToPhotos.mockImplementation( ( ) => {
      const err = new Error( "“IMG.CR3” couldn’t be copied to “tmp”" );
      err.code = "out-of-space";
      return Promise.reject( err );
    } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    // The first file's failure is the whole device's answer for the other 39.
    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 1 );
    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_out_of_space",
      expect.objectContaining( { abandoned: 39, saved: 0, failed: 1 } ),
    );

    // And the next scans don't start it over.
    await jest.advanceTimersByTimeAsync( 60_000 );
    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 1 );
  } );

  // Every log line is a network POST. A run that fails file after file used to
  // send one per file; the abandon line above carries the totals.
  it( "logs the first few save failures, not one per file", async ( ) => {
    mockSaveUsbImageToPhotos.mockImplementation( async relativePath => {
      if ( Number( relativePath.match( /\d+/ )[0] ) % 2 === 0 ) {
        throw new Error( "unreadable file" );
      }
      return { localIdentifier: relativePath };
    } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    // 20 of the 40 failed, alternating so no three are consecutive and the run
    // is never abandoned.
    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 40 );
    expect( mockLogger.errorWithExtra.mock.calls.filter(
      ( [msg] ) => typeof msg === "string" && msg.startsWith( "USB offload: failed to save" ),
    ) ).toHaveLength( 3 );
    expect( mockLogger.info ).toHaveBeenCalledWith(
      expect.stringContaining( "USB offload: saved 20, failed 20" ),
    );
  } );

  // iOS gives no attach notification, and a drive is normally plugged in with
  // the app already open — a moment that fires neither a launch nor a
  // foreground event, which is the whole reason this hook polls. But the saved
  // folder does not resolve while the drive is unplugged, and a null folder
  // name used to skip setting up the interval at all: the scan only ever ran if
  // the drive happened to already be mounted at launch or at the last
  // foreground, so the one case polling exists for was the one it never
  // noticed.
  it( "picks up a drive attached while the app is already open", async ( ) => {
    mockGetUsbFolderName.mockResolvedValue( null );
    mockListNewUsbImages.mockResolvedValue( {
      available: false,
      reason: "drive-disconnected",
      images: [],
    } );
    mockSaveUsbImageToPhotos.mockResolvedValue( { localIdentifier: "x" } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );
    expect( mockSaveUsbImageToPhotos ).not.toHaveBeenCalled( );

    // The drive goes in. Nothing else happens: no relaunch, no foregrounding,
    // just the next scan.
    mockListNewUsbImages.mockResolvedValue( {
      available: true,
      images: images( 2 ),
      imageFileCount: 2,
      alreadyImportedCount: 0,
      knownCount: 0,
      regularFileCount: 2,
      extensions: { cr3: 2 },
    } );
    await jest.advanceTimersByTimeAsync( 10_000 );

    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 2 );
  } );

  // The other cause of a null folder name: nothing to watch, so don't wake the
  // JS thread every ten seconds for the many users who never picked a folder.
  it( "does not poll when no folder was ever picked", async ( ) => {
    mockGetUsbFolderName.mockResolvedValue( null );
    mockGetUsbFolderDiagnostics.mockResolvedValue( { bookmarkPresent: false } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 60_000 );

    expect( mockListNewUsbImages ).not.toHaveBeenCalled( );
  } );

  it( "carries on past an ordinary failure that is not a timeout", async ( ) => {
    mockSaveUsbImageToPhotos.mockImplementation( async relativePath => {
      if ( relativePath === "IMG_0.CR3" ) throw new Error( "unreadable file" );
      return { localIdentifier: relativePath };
    } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    expect( mockSaveUsbImageToPhotos ).toHaveBeenCalledTimes( 40 );
    expect( mockLogger.errorWithExtra ).not.toHaveBeenCalledWith(
      "usb_offload_library_wedged",
      expect.anything( ),
    );
  } );
} );
