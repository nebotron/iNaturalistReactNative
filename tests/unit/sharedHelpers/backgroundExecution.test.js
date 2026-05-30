jest.mock( "react-native-background-actions", ( ) => ( {
  __esModule: true,
  default: {
    isRunning: jest.fn( ( ) => false ),
    start: jest.fn( ( ) => Promise.resolve( ) ),
    stop: jest.fn( ( ) => Promise.resolve( ) ),
  },
} ) );

jest.mock( "i18next", ( ) => ( {
  t: jest.fn( key => key ),
} ) );

import BackgroundService from "react-native-background-actions";
import {
  beginBackgroundUploadTask,
  endBackgroundUploadTask,
  isBackgroundUploadTaskRunning,
} from "sharedHelpers/backgroundExecution";

describe( "backgroundExecution", ( ) => {
  beforeEach( ( ) => {
    jest.clearAllMocks( );
    BackgroundService.isRunning.mockReturnValue( false );
  } );

  it( "reports whether the background upload task is running", ( ) => {
    BackgroundService.isRunning.mockReturnValue( true );
    expect( isBackgroundUploadTaskRunning( ) ).toBe( true );
  } );

  it( "starts the background upload task when it is not already running", async ( ) => {
    const started = await beginBackgroundUploadTask( );

    expect( started ).toBe( true );
    expect( BackgroundService.start ).toHaveBeenCalledTimes( 1 );
  } );

  it( "does not start the background upload task when it is already running", async ( ) => {
    BackgroundService.isRunning.mockReturnValue( true );

    const started = await beginBackgroundUploadTask( );

    expect( started ).toBe( true );
    expect( BackgroundService.start ).not.toHaveBeenCalled( );
  } );

  it( "returns false when starting the background upload task fails", async ( ) => {
    BackgroundService.start.mockRejectedValueOnce( new Error( "start failed" ) );

    const started = await beginBackgroundUploadTask( );

    expect( started ).toBe( false );
  } );

  it( "stops the background upload task when it is running", async ( ) => {
    BackgroundService.isRunning.mockReturnValue( true );

    await endBackgroundUploadTask( );

    expect( BackgroundService.stop ).toHaveBeenCalledTimes( 1 );
  } );

  it( "does not stop the background upload task when it is not running", async ( ) => {
    await endBackgroundUploadTask( );

    expect( BackgroundService.stop ).not.toHaveBeenCalled( );
  } );
} );
