import createUploadAbortController from "uploaders/utils/uploadAbort";

const TIMEOUT_MS = 300_000;

describe( "createUploadAbortController", ( ) => {
  beforeEach( ( ) => jest.useFakeTimers( ) );
  afterEach( ( ) => jest.useRealTimers( ) );

  it( "aborts itself and reports the timeout once its own budget expires", ( ) => {
    const onTimeout = jest.fn( );
    const session = new AbortController( );
    const { signal } = createUploadAbortController( session.signal, TIMEOUT_MS, onTimeout );

    jest.advanceTimersByTime( TIMEOUT_MS - 1 );
    expect( signal.aborted ).toBe( false );
    expect( onTimeout ).not.toHaveBeenCalled( );

    jest.advanceTimersByTime( 1 );
    expect( signal.aborted ).toBe( true );
    expect( onTimeout ).toHaveBeenCalledTimes( 1 );
  } );

  it( "does not abort a sibling upload when one upload times out", ( ) => {
    const session = new AbortController( );
    // The older upload is 9s from its deadline when the younger one expires,
    // which is the Aug 5 19:51:36 pair: 300004ms and 290811ms, one abort.
    const older = createUploadAbortController( session.signal, TIMEOUT_MS, ( ) => {} );
    jest.advanceTimersByTime( TIMEOUT_MS - 9_000 );
    const younger = createUploadAbortController( session.signal, 1_000, ( ) => {} );

    jest.advanceTimersByTime( 1_000 );
    expect( younger.signal.aborted ).toBe( true );
    expect( older.signal.aborted ).toBe( false );
    expect( session.signal.aborted ).toBe( false );
  } );

  it( "aborts every upload when the session is cancelled", ( ) => {
    const session = new AbortController( );
    const first = createUploadAbortController( session.signal, TIMEOUT_MS, ( ) => {} );
    const second = createUploadAbortController( session.signal, TIMEOUT_MS, ( ) => {} );

    session.abort( );

    expect( first.signal.aborted ).toBe( true );
    expect( second.signal.aborted ).toBe( true );
  } );

  it( "aborts immediately when the session was already cancelled", ( ) => {
    const session = new AbortController( );
    session.abort( );

    const { signal } = createUploadAbortController( session.signal, TIMEOUT_MS, ( ) => {} );

    expect( signal.aborted ).toBe( true );
  } );

  it( "leaves no live timer behind after a failed upload is released", ( ) => {
    const onTimeout = jest.fn( );
    const session = new AbortController( );
    const failed = createUploadAbortController( session.signal, TIMEOUT_MS, onTimeout );

    // The upload throws a second in; `release` runs in the finally.
    jest.advanceTimersByTime( 1_000 );
    failed.release( );

    // A later upload must survive the dead attempt's deadline, which now falls
    // in the middle of its own budget rather than at the end of it.
    const later = createUploadAbortController( session.signal, TIMEOUT_MS, ( ) => {} );
    jest.advanceTimersByTime( TIMEOUT_MS - 500 );

    expect( onTimeout ).not.toHaveBeenCalled( );
    expect( later.signal.aborted ).toBe( false );
  } );

  it( "stops listening to the session once released", ( ) => {
    const session = new AbortController( );
    const { signal, release } = createUploadAbortController(
      session.signal,
      TIMEOUT_MS,
      ( ) => {},
    );

    release( );
    session.abort( );

    expect( signal.aborted ).toBe( false );
  } );
} );
