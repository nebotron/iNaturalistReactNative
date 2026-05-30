import { INatApiError } from "api/error";

const RETRY_DELAY_MS = 5000;
const RETRY_JITTER_MS = 2000;

function isRetryableError( error: unknown ): boolean {
  if ( error instanceof INatApiError ) {
    return error.status >= 500;
  }
  // No HTTP response received — network/connection failure
  return !( error instanceof INatApiError );
}

async function withRetry<T>( fn: () => Promise<T> ): Promise<T> {
  try {
    return await fn();
  } catch ( error ) {
    if ( !isRetryableError( error ) ) {
      throw error;
    }
    const delay = RETRY_DELAY_MS + Math.random() * RETRY_JITTER_MS;
    await new Promise( resolve => setTimeout( resolve, delay ) );
    return fn();
  }
}

export default withRetry;
