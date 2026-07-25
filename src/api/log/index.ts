import Config from "react-native-config";
import type { transportFunctionType } from "react-native-logs";
// The git commit the bundle was built from (see scripts/writeAppCommit.js).
import APP_COMMIT from "sharedHelpers/appCommit";
import { isObject, isObjectWithPrimitiveValues } from "sharedHelpers/runtimeTypeUtil";

import { extraSentinelKey } from "./enhanceLoggerWithExtra";

// at least answers: does it look enough like an Error for logging purposes?
function isError( value: unknown ): value is { message?: string; stack?: string } {
  if ( value instanceof Error ) {
    return true;
  }
  if ( isObject( value ) && "stack" in value && "message" in value ) {
    return true;
  }
  return false;
}

// If we have anything that looks like:
// [someObj, 'asdfasdf', 3, { [extraSentinelKey]: { id: 1, ... } }]
// where the _last_ rest param is an obj w/ exactly this sentinel property w/ primitive fields,
// we infer that last item as intended for the special `extra` field
// we return that separately and strip it from the "normal" rest params for later handling
function extractExtra( rawMsg: unknown ) {
  const nonExtraResult = {
    messageParams: rawMsg,
    extra: undefined,
  };

  // make sure we least look like [...someItems, maybeExtra]
  if ( !Array.isArray( rawMsg ) || rawMsg.length < 2 ) {
    return nonExtraResult;
  }
  // make sure maybeExtra looks like { extra: ??? }
  const extraWrapperCandidate = rawMsg.at( -1 );
  if (
    !isObject( extraWrapperCandidate )
    // limit to _exactly_ just this property to minimize accidentally classifying `extra`
    || Object.keys( extraWrapperCandidate ).length !== 1
    || !( extraSentinelKey in extraWrapperCandidate )
  ) {
    return nonExtraResult;
  }
  // make sure our extra is actually valid
  const extraCandidate = extraWrapperCandidate[extraSentinelKey];
  if ( !isObjectWithPrimitiveValues( extraCandidate ) ) {
    return nonExtraResult;
  }
  return {
    // the rest of the log handling should act as if extra was separate from the rest params
    messageParams: rawMsg.slice( 0, -1 ),
    extra: extraCandidate,
  };
}

// our transport has no options but this needs to be explicitly `object` for generic typing
type firebaseLogTransportOptions = object;

// Custom transport that appends each log line as a push-ID child of
// {CROP_LOG_FIREBASE_URL}/app_log. The log DB allows unauthenticated
// writes, so no auth token is needed (same as the crop/brightness logs).
const firebaseLogTransport: transportFunctionType<firebaseLogTransportOptions> = async props => {
  // Don't bother to log from dev builds
  if ( __DEV__ ) return;

  const baseUrl = Config.CROP_LOG_FIREBASE_URL;
  if ( !baseUrl ) return;

  // pull potential `extra` out of the rest params
  const { messageParams, extra } = extractExtra( props.rawMsg );

  // if message is an Error or is an array ending in an error, extract it
  // so we can report its stack alongside the message
  let message: string;
  let error: { message?: string; stack?: string } | undefined;
  if ( typeof ( messageParams ) === "string" ) {
    message = messageParams;
  } else if ( isError( messageParams ) ) {
    error = messageParams;
    message = error.message ?? "Unknown error";
  } else if ( Array.isArray( messageParams ) ) {
    const last = messageParams.at( -1 );
    if ( isError( last ) ) {
      error = last;
      message = [...messageParams.slice( 0, -1 ), error.message ?? "Unknown error"].join( " " );
    } else {
      message = messageParams.join( " " );
    }
  } else {
    message = JSON.stringify( messageParams );
  }

  const entry = {
    timestamp: new Date( ).toISOString( ),
    level: props.level.text,
    extension: props.extension,
    // commit lets a log line be traced back to the exact code that produced it
    commit: APP_COMMIT,
    message,
    ...( extra ?? {} ),
    ...( error?.stack
      ? { stack: error.stack }
      : {} ),
  };

  const body = JSON.stringify( entry );
  // Errors are the entries we most need to keep, so give them a few retries
  // rather than dropping them on a transient network failure. Non-errors sync
  // once to avoid amplifying high-volume info logging.
  const maxAttempts = props.level.text === "error"
    ? 3
    : 1;
  for ( let attempt = 1; attempt <= maxAttempts; attempt += 1 ) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch( `${baseUrl}/app_log.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      } );
      if ( r.ok ) return;
      if ( attempt === maxAttempts ) return;
    } catch {
      if ( attempt === maxAttempts ) return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise( resolve => { setTimeout( resolve, 500 * attempt ); } );
  }
};

export { default as enhanceLoggerWithExtra } from "./enhanceLoggerWithExtra";

export default firebaseLogTransport;
