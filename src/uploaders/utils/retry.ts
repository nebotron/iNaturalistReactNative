import { INatApiError } from "api/error";

const RETRY_DELAY_MS = 5000;
const RETRY_JITTER_MS = 2000;
const MAX_RETRIES = 3;

function isRetryableError( error: unknown ): boolean {
  if ( error instanceof INatApiError ) {
    return error.status >= 500;
  }
  // No HTTP response received — network/connection failure
  return !( error instanceof INatApiError );
}

async function withRetry<T>( fn: () => Promise<T> ): Promise<T> {
  let lastError: unknown;
  for ( let attempt = 0; attempt < MAX_RETRIES; attempt++ ) {
    try {
      return await fn();
    } catch ( error ) {
      if ( !isRetryableError( error ) ) {
        throw error;
      }
      lastError = error;
      if ( attempt < MAX_RETRIES - 1 ) {
        const delay = RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS;
        await new Promise( resolve => setTimeout( resolve, delay ) );
      }
    }
  }
  throw lastError;
}

export default withRetry;
