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
// [someObj, 'asdfasdf', 3, { [extraSentinelKey]: true, id: 1, ... }]
// where the _last_ rest param is an obj flagged w/ this sentinel property and otherwise
// has only primitive fields, we infer that last item as intended for the special `extra`
// API field. we return that separately and strip it from the "normal" rest params for
// later handling
function extractExtra( rawMsg: unknown ) {
  const nonExtraResult = {
    messageParams: rawMsg,
    extra: undefined,
  };

  // make sure we least look like [...someItems, maybeExtra]
  if ( !Array.isArray( rawMsg ) || rawMsg.length < 2 ) {
    return nonExtraResult;
  }
  // make sure maybeExtra looks like { [extraSentinelKey]: true, ... }
  const extraWrapperCandidate = rawMsg.at( -1 );
  if (
    !isObject( extraWrapperCandidate )
    || !( extraSentinelKey in extraWrapperCandidate )
    || extraWrapperCandidate[extraSentinelKey] !== true
  ) {
    return nonExtraResult;
  }
  // make sure our extra is actually valid for the API
  const { [extraSentinelKey]: _sentinel, ...extraCandidate } = extraWrapperCandidate;
  if ( !isObjectWithPrimitiveValues( extraCandidate ) ) {
    return nonExtraResult;
  }
  return {
    // the rest of the log handling should act as if extra was separate from the rest params
    messageParams: rawMsg.slice( 0, -1 ),
    extra: extraCandidate,
  };
}

// The log DB is publicly readable, so strip credentials and coordinates from
// anything we send. Values are matched in plain text, JSON (incl. escaped
// JSON inside a message string), and URL query strings.
const SECRET_KEYS = "api_token|access_token|refresh_token|id_token|authorization|password"
  + "|jwt|token|secret|api_key|apikey";
const LOCATION_KEYS = "latitude|longitude|private_latitude|private_longitude|lat|lng|lon"
  + "|nelat|nelng|swlat|swlng";
const KEY_PREFIX = "(\\\\?\"?\\b(?:{keys})\\\\?\"?\\s*[:=]\\s*\\\\?\"?)";
const SECRET_VALUE_RE = new RegExp( `${KEY_PREFIX.replace( "{keys}", SECRET_KEYS )}`
  + "(?:Bearer\\s+)?[^\"\\\\&,\\s}]+", "gi" );
const LOCATION_VALUE_RE = new RegExp( `${KEY_PREFIX.replace( "{keys}", LOCATION_KEYS )}`
  + "-?\\d+(?:\\.\\d+)?", "gi" );
const JWT_RE = /eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g;
// "37.1234,-122.5678", e.g. a location param or a formatted coordinate pair
const COORD_PAIR_RE = /-?\d{1,3}\.\d{3,}\s*(?:,|%2C)\s*-?\d{1,3}\.\d{3,}/gi;
const SENSITIVE_KEY_RE = new RegExp( `^(?:${SECRET_KEYS}|${LOCATION_KEYS}|location|coords)$`, "i" );
const REDACTED = "[REDACTED]";

export function redact( text: string ): string {
  return text
    .replace( JWT_RE, REDACTED )
    .replace( SECRET_VALUE_RE, `$1${REDACTED}` )
    .replace( LOCATION_VALUE_RE, `$1${REDACTED}` )
    .replace( COORD_PAIR_RE, REDACTED );
}

function redactExtra( extra: Record<string, unknown> ) {
  return Object.fromEntries( Object.entries( extra ).map( ( [key, value] ) => [
    key,
    // eslint-disable-next-line no-nested-ternary
    SENSITIVE_KEY_RE.test( key )
      ? REDACTED
      : typeof value === "string"
        ? redact( value )
        : value,
  ] ) );
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
    message: redact( message ),
    ...( extra
      ? redactExtra( extra )
      : {} ),
    ...( error?.stack
      ? { stack: redact( error.stack ) }
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
    } catch {
      // Retry below, or give up once the loop runs out of attempts. Never
      // rethrow: we log to report errors, so failing to log must stay silent.
    }
    if ( attempt < maxAttempts ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise( resolve => { setTimeout( resolve, 500 * attempt ); } );
    }
  }
};

export { default as enhanceLoggerWithExtra } from "./enhanceLoggerWithExtra";

export default firebaseLogTransport;
