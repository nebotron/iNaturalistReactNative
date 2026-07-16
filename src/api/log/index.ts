import {
  getCrashlytics,
  log as crashlyticsLog,
  recordError,
  setAttributes,
} from "@react-native-firebase/crashlytics";
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

// Crashlytics.recordError expects a real Error instance
function toError( value: { message?: string; stack?: string } ): Error {
  if ( value instanceof Error ) return value;
  const error = new Error( value.message ?? "Unknown error" );
  if ( value.stack ) error.stack = value.stack;
  return error;
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

// Custom transport for logging to Firebase Crashlytics
const firebaseLogTransport: transportFunctionType<firebaseLogTransportOptions> = async props => {
  // Don't bother to log from dev builds
  if ( __DEV__ ) return;

  // pull potential `extra` out of the rest params
  const { messageParams, extra } = extractExtra( props.rawMsg );

  // if message is an Error or is an array ending in an error, extract it
  // so we can report it as a non-fatal error, not just a log line
  let message: string;
  let error: Error | undefined;
  if ( typeof ( messageParams ) === "string" ) {
    message = messageParams;
  } else if ( isError( messageParams ) ) {
    error = toError( messageParams );
    ( { message } = error );
  } else if ( Array.isArray( messageParams ) ) {
    // specially handle the cases where the last arg is
    // an error: so we can attach appropriate error metadata
    const last = messageParams.at( -1 );
    if ( isError( last ) ) {
      error = toError( last );
      message = [...messageParams.slice( 0, -1 ), error.message].join( " " );
    } else {
      message = messageParams.join( " " );
    }
  } else {
    message = JSON.stringify( messageParams );
  }

  try {
    const crashlytics = getCrashlytics();
    if ( extra ) {
      const stringifiedExtra = Object.fromEntries(
        Object.entries( extra ).map( ( [key, value] ) => [key, String( value )] ),
      );
      await setAttributes( crashlytics, stringifiedExtra );
    }
    crashlyticsLog( crashlytics, `[${props.level.text}] [${props.extension}] ${message}` );
    if ( error ) {
      recordError( crashlytics, error );
    }
  } catch ( crashlyticsError ) {
    console.error( "[ERROR log.ts] failed to log to Crashlytics", crashlyticsError );
  }
};

export { default as enhanceLoggerWithExtra } from "./enhanceLoggerWithExtra";

export default firebaseLogTransport;
