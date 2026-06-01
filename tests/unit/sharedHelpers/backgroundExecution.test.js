import {
  beginBackgroundUploadTask,
  endBackgroundUploadTask,
  isBackgroundUploadTaskRunning,
} from "sharedHelpers/backgroundExecution";

describe( "backgroundExecution", ( ) => {
  beforeEach( async ( ) => {
    await endBackgroundUploadTask( );
  } );

  it( "reports that the background upload task is not running initially", ( ) => {
    expect( isBackgroundUploadTaskRunning( ) ).toBe( false );
  } );

  it( "starts the background upload task", async ( ) => {
    const started = await beginBackgroundUploadTask( );

    expect( started ).toBe( true );
    expect( isBackgroundUploadTaskRunning( ) ).toBe( true );
  } );

  it( "does not restart the background upload task when it is already running", async ( ) => {
    await beginBackgroundUploadTask( );

    const startedAgain = await beginBackgroundUploadTask( );

    expect( startedAgain ).toBe( true );
    expect( isBackgroundUploadTaskRunning( ) ).toBe( true );
  } );

  it( "stops the background upload task when it is running", async ( ) => {
    await beginBackgroundUploadTask( );

    await endBackgroundUploadTask( );

    expect( isBackgroundUploadTaskRunning( ) ).toBe( false );
  } );

  it( "does not fail when stopping the background upload task that is not running", async ( ) => {
    await endBackgroundUploadTask( );

    expect( isBackgroundUploadTaskRunning( ) ).toBe( false );
  } );
} );
