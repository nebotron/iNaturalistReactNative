import { INatApiError } from "api/error";

const RETRY_DELAY_MS = 5000;
const RETRY_JITTER_MS = 2000;
const MAX_RETRIES = 3;

interface RetryOptions {
  // Statuses that are normally fatal but are worth one more try in a specific
  // call's context, e.g. a 404 on a record the server only just created.
  alsoRetryStatuses?: number[];
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
      const delay = RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS;
      // eslint-disable-next-line no-await-in-loop
      await new Promise( resolve => {
        setTimeout( resolve, delay );
      } );
    }
  }
}

export default withRetry;
