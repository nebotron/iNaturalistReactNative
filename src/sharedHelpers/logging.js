import { getJWT } from "components/LoginSignUp/AuthenticationService";

import { log } from "../../react-native-logs.config";

const defaultLogger = log.extend( "logging.js" );

// returns string representation of an object, intended for debugging
function inspect( target ) {
  return JSON.stringify( target );
}

function handleRetryDelay( failureCount ) {
  return Math.min( 1000 * 2 ** failureCount, 30000 );
}

// Note that this should not be async. When you're using it with reactQuery,
// returning a promise is like returning true, which means it retries forever.
// Retries only on 5xx errors or network connection failures.
function reactQueryRetry( failureCount, error ) {
  const isNetworkFailure = error instanceof TypeError
    && /Network request failed/i.test( error.message );
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

// eslint-disable-next-line import/prefer-default-export
export {
  handleRetryDelay,
  inspect,
  reactQueryRetry,
};
