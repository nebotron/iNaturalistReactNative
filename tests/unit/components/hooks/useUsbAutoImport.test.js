import { renderHook } from "@testing-library/react-native";
import useUsbAutoImport from "components/hooks/useUsbAutoImport";

const mockListNewUsbImages = jest.fn( );
const mockSaveUsbImageToPhotos = jest.fn( );
const mockMarkUsbImagesImported = jest.fn( );
const mockDeleteUsbSourceImages = jest.fn( async ( ) => ( { deleted: 0, failed: 0 } ) );
const mockClearUsbOffloadMarker = jest.fn( );
const mockMarkUsbOffloadStarted = jest.fn( );
const mockTakeUnfinishedUsbOffload = jest.fn( ( ) => null );
const mockUpdateUsbOffloadProgress = jest.fn( );

jest.mock( "sharedHelpers/usbStorage", ( ) => ( {
  clearUsbOffloadMarker: ( ) => mockClearUsbOffloadMarker( ),
  deleteUsbSourceImages: ( ...args ) => mockDeleteUsbSourceImages( ...args ),
  getUsbFolderDiagnostics: async ( ) => ( { bookmarkPresent: true } ),
  getUsbFolderName: async ( ) => "101EOSR7",
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
    } );
    mockSaveUsbImageToPhotos.mockResolvedValue( { localIdentifier: "x" } );

    renderHook( ( ) => useUsbAutoImport( ) );
    await jest.advanceTimersByTimeAsync( 0 );

    expect( mockLogger.errorWithExtra ).toHaveBeenCalledWith(
      "usb_offload_never_finished",
      expect.objectContaining( { total: 80, saved: 12, failed: 1 } ),
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
    expect( mockLogger.info ).toHaveBeenCalledWith(
      expect.stringContaining( "USB offload: saved 0, failed 40" ),
    );
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
