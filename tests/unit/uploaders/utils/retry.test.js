import NetInfo from "@react-native-community/netinfo";
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

  it( "retries a retryable error up to three times", async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce( apiError( 500 ) )
      .mockRejectedValueOnce( apiError( 500 ) )
      .mockRejectedValueOnce( apiError( 500 ) )
      .mockResolvedValueOnce( "ok" );

    await expect( settle( withRetry( fn ) ) ).resolves.toEqual( "ok" );
    expect( fn ).toHaveBeenCalledTimes( 4 );
  } );

  it( "gives up after three retries", async () => {
    const fn = jest.fn().mockRejectedValue( apiError( 500 ) );

    await expect( settle( withRetry( fn ) ) ).resolves.toBeInstanceOf( INatApiError );
    expect( fn ).toHaveBeenCalledTimes( 4 );
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

  describe( "while offline", () => {
    let reconnect;
    beforeEach( () => {
      NetInfo.fetch.mockResolvedValueOnce( { isConnected: false } );
      NetInfo.addEventListener.mockImplementationOnce( listener => {
        reconnect = () => listener( { isConnected: true } );
        return jest.fn();
      } );
    } );
    afterEach( () => NetInfo.addEventListener.mockReset() );

    it( "waits for the connection without spending a retry", async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce( new Error( "Network request failed" ) )
        .mockRejectedValueOnce( apiError( 500 ) )
        .mockRejectedValueOnce( apiError( 500 ) )
        .mockRejectedValueOnce( apiError( 500 ) )
        .mockResolvedValueOnce( "ok" );

      const result = withRetry( fn );
      await jest.runAllTimersAsync();
      expect( fn ).toHaveBeenCalledTimes( 1 );

      reconnect();
      await expect( settle( result ) ).resolves.toEqual( "ok" );
      expect( fn ).toHaveBeenCalledTimes( 5 );
    } );

    it( "stops waiting when the upload is aborted", async () => {
      const controller = new AbortController();
      const abortError = new Error( "Aborted" );
      abortError.name = "AbortError";
      const fn = jest.fn()
        .mockRejectedValueOnce( new Error( "Network request failed" ) )
        .mockRejectedValueOnce( abortError );

      const result = withRetry( fn, { signal: controller.signal } );
      await jest.runAllTimersAsync();
      controller.abort();
      await expect( settle( result ) ).resolves.toBe( abortError );
      expect( fn ).toHaveBeenCalledTimes( 2 );
    } );
  } );
} );
