import { getJWT } from "components/LoginSignUp/AuthenticationService";

import { log } from "../../react-native-logs.config";

const defaultLogger = log.extend( "logging.js" );

function handleRetryDelay( failureCount ) {
  return Math.min( 1000 * 2 ** failureCount, 30000 );
}

// A stalled fetch has no upper bound of its own, so a network hiccup that
// never surfaces a connection error just sits there — see slowLoadTracker's
// HANG_FETCH_MS, which is where the app itself gives up waiting and reports
// one of these as a hang rather than a request that ever resolved. Aborting
// authenticated requests at the same threshold (see useAuthenticatedQuery /
// useAuthenticatedInfiniteQuery) turns that indefinite hang into a retryable
// failure instead.
const REQUEST_TIMEOUT_MS = 20000;

const createRequestTimeoutSignal = ( ) => {
  const controller = new AbortController( );
  const timer = setTimeout( ( ) => controller.abort( ), REQUEST_TIMEOUT_MS );
  return {
    signal: controller.signal,
    clear: ( ) => clearTimeout( timer ),
  };
};

// Note that this should not be async. When you're using it with reactQuery,
// returning a promise is like returning true, which means it retries forever.
// Retries only on 5xx errors, network connection failures, or our own
// request-timeout abort (see createRequestTimeoutSignal above).
function reactQueryRetry( failureCount, error ) {
  const isNetworkFailure = ( error instanceof TypeError
    && /Network request failed/i.test( error.message ) )
    || error?.name === "AbortError";
  const status = error.status ?? error.response?.status;
  const is5xx = typeof status === "number" && status >= 500 && status < 600;

  // JWT refresh side-effect on auth errors — fire-and-forget, no retry
  if ( status === 401 || status === 403 ) {
    getJWT( true ).catch( refreshError => {
      defaultLogger.error( "Error refreshing JWT during retry:", refreshError );
    } );
    return false;
  }

  if ( !isNetworkFailure && !is5xx ) {
    return false;
  }

  const shouldRetry = failureCount < 3;
  if ( shouldRetry ) {
    const label = isNetworkFailure
      ? "Network failure"
      : `HTTP ${status}`;
    defaultLogger.warn( `reactQueryRetry: ${label}, attempt ${failureCount + 1}` );
  }

  return shouldRetry;
}

export {
  createRequestTimeoutSignal,
  handleRetryDelay,
  reactQueryRetry,
};
