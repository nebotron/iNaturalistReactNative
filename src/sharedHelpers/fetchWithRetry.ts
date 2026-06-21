const MAX_RETRIES = 3;

// Retries on network errors and 5xx responses; returns immediately for 4xx/2xx/3xx.
async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for ( let attempt = 0; attempt < MAX_RETRIES; attempt++ ) {
    try {
      const response = await fetch( input, init );
      if ( response.status < 500 ) return response;
      lastError = new Error( `HTTP ${response.status}` );
    } catch ( error ) {
      lastError = error;
    }
    if ( attempt < MAX_RETRIES - 1 ) {
      const delay = Math.min( 1000 * 2 ** attempt, 30000 );
      await new Promise( resolve => setTimeout( resolve, delay ) );
    }
  }
  throw lastError;
}

export default fetchWithRetry;
