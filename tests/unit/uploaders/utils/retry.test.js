import { INatApiError } from "api/error";
import withRetry from "uploaders/utils/retry";

const apiError = status => new INatApiError( { status }, status );

describe( "withRetry", () => {
  beforeEach( () => jest.useFakeTimers() );
  afterEach( () => jest.useRealTimers() );

  // withRetry sleeps between attempts, so every assertion has to drain the
  // timers before the retry actually happens.
  const settle = async promise => {
    const assertable = promise.catch( error => error );
    await jest.runAllTimersAsync();
    return assertable;
  };

  it( "retries server errors", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce( apiError( 500 ) )
      .mockResolvedValueOnce( "ok" );

    await expect( settle( withRetry( fn ) ) ).resolves.toEqual( "ok" );
    expect( fn ).toHaveBeenCalledTimes( 2 );
  } );

  it( "retries network failures", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce( new Error( "Network request failed" ) )
      .mockResolvedValueOnce( "ok" );

    await expect( settle( withRetry( fn ) ) ).resolves.toEqual( "ok" );
    expect( fn ).toHaveBeenCalledTimes( 2 );
  } );

  it( "does not retry client errors by default", async () => {
    const fn = jest.fn().mockRejectedValue( apiError( 404 ) );

    await expect( settle( withRetry( fn ) ) ).resolves.toBeInstanceOf( INatApiError );
    expect( fn ).toHaveBeenCalledTimes( 1 );
  } );

  it( "retries a client error the caller opted into", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce( apiError( 404 ) )
      .mockResolvedValueOnce( "ok" );

    await expect(
      settle( withRetry( fn, { alsoRetryStatuses: [404] } ) ),
    ).resolves.toEqual( "ok" );
    expect( fn ).toHaveBeenCalledTimes( 2 );
  } );

  it( "still does not retry client errors the caller did not opt into", async () => {
    const fn = jest.fn().mockRejectedValue( apiError( 422 ) );

    await expect(
      settle( withRetry( fn, { alsoRetryStatuses: [404] } ) ),
    ).resolves.toBeInstanceOf( INatApiError );
    expect( fn ).toHaveBeenCalledTimes( 1 );
  } );
} );
