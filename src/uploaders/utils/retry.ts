import NetInfo from "@react-native-community/netinfo";
import { INatApiError } from "api/error";

const RETRY_DELAY_MS = 5000;
const RETRY_JITTER_MS = 2000;
const MAX_RETRIES = 3;

interface RetryOptions {
  // Statuses that are normally fatal but are worth one more try in a specific
  // call's context, e.g. a 404 on a record the server only just created.
  alsoRetryStatuses?: number[];
  // The upload's signal, so a wait for the connection to come back ends when
  // the user stops the upload or it reaches its timeout.
  signal?: AbortSignal;
}

// Resolves once the device reports a connection again, or the signal aborts.
function waitForConnection( signal?: AbortSignal ): Promise<void> {
  return new Promise( resolve => {
    if ( signal?.aborted ) {
      resolve( );
      return;
    }
    let settled = false;
    let unsubscribe: ( ) => void = ( ) => {};
    const finish = ( ) => {
      if ( settled ) return;
      settled = true;
      unsubscribe( );
      signal?.removeEventListener( "abort", finish );
      resolve( );
    };
    signal?.addEventListener( "abort", finish );
    unsubscribe = NetInfo.addEventListener( state => {
      if ( state.isConnected !== false ) finish( );
    } );
    // The listener can fire synchronously, before unsubscribe was assigned
    if ( settled ) unsubscribe( );
  } );
}

function isRetryableError( error: unknown, options: RetryOptions ): boolean {
  // An abort is a decision, not a failure: retrying it would resurrect an
  // upload the user stopped or that we gave up on at its timeout.
  if ( error instanceof Error && error.name === "AbortError" ) {
    return false;
  }
  if ( error instanceof INatApiError ) {
    return error.status >= 500
      || !!options.alsoRetryStatuses?.includes( error.status );
  }
  // No HTTP response received — network/connection failure
  return !( error instanceof INatApiError );
}

async function withRetry<T>( fn: () => Promise<T>, options: RetryOptions = {} ): Promise<T> {
  for ( let attempt = 0; ; attempt += 1 ) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch ( error ) {
      if ( attempt >= MAX_RETRIES || !isRetryableError( error, options ) ) {
        throw error;
      }
      // On a flaky connection a dropout can outlast every retry below, failing
      // the upload until the user retries by hand. While the device is
      // offline, wait for it to reconnect instead, without spending a retry.
      if ( !( error instanceof INatApiError ) ) {
        // eslint-disable-next-line no-await-in-loop
        const netState = await NetInfo.fetch( );
        if ( netState?.isConnected === false ) {
          // eslint-disable-next-line no-await-in-loop
          await waitForConnection( options.signal );
          attempt -= 1;
        }
      }
      const delay = RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS;
      // eslint-disable-next-line no-await-in-loop
      await new Promise( resolve => {
        setTimeout( resolve, delay );
      } );
    }
  }
}

export default withRetry;
