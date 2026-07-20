import Config from "react-native-config";
import type { transportFunctionType } from "react-native-logs";
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
    console.warn( "[ERROR log.ts] `extra` must be a non-nested object with primitive values" );
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
    message,
    ...( extra ?? {} ),
    ...( error?.stack
      ? { stack: error.stack }
      : {} ),
  };

  try {
    const r = await fetch( `${baseUrl}/app_log.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify( entry ),
    } );
    if ( !r.ok ) console.warn( "[ERROR log.ts] failed to sync log entry", r.status );
  } catch ( syncError ) {
    console.warn( "[ERROR log.ts] failed to sync log entry", syncError );
  }
};

export { default as enhanceLoggerWithExtra } from "./enhanceLoggerWithExtra";

export default firebaseLogTransport;
