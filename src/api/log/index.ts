import { AppState } from "react-native";
import Config from "react-native-config";
import type { transportFunctionType } from "react-native-logs";
import { MMKV } from "react-native-mmkv";
// The git commit the bundle was built from (see scripts/writeAppCommit.js).
import APP_COMMIT from "sharedHelpers/appCommit";
import { isObject, isPrimitive } from "sharedHelpers/runtimeTypeUtil";

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
  // Serialize nested values (e.g. arrays of timings) rather than dropping the
  // whole extra, which logged it as "[object Object]"
  const { [extraSentinelKey]: _sentinel, ...extraCandidate } = extraWrapperCandidate;
  const extra = Object.fromEntries( Object.entries( extraCandidate ).map( ( [key, value] ) => [
    key,
    isPrimitive( value )
      ? value
      : JSON.stringify( value ),
  ] ) );
  return {
    // the rest of the log handling should act as if extra was separate from the rest params
    messageParams: rawMsg.slice( 0, -1 ),
    extra,
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

// Lines are sent in batches, one PATCH of push-ID children per batch, rather
// than one POST per line. Long and large, so the radio wakes rarely; anything
// still queued when the app dies goes out with the next launch (see `pending`).
const FLUSH_MS = 60_000;
const MAX_BATCH = 50;
let queue: Record<string, { level: string }> = {};
let queued = 0;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
// Each queued line is also kept here until its batch is sent, so a launch that
// crashes or hangs before its first flush is reported by the next launch
// instead of vanishing.
const pending = new MMKV( { id: "app-log-pending" } );

// Client-side Firebase push IDs: a timestamp prefix, so app_log.py's $key
// ordering stays chronological, and random characters to keep them unique.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
const pushId = ( ) => {
  let time = Date.now( );
  let id = "";
  for ( let i = 0; i < 8; i += 1 ) {
    id = PUSH_CHARS.charAt( time % 64 ) + id;
    time = Math.floor( time / 64 );
  }
  for ( let i = 0; i < 12; i += 1 ) {
    id += PUSH_CHARS.charAt( Math.floor( Math.random( ) * 64 ) );
  }
  return id;
};

export const flushLogs = async ( ) => {
  clearTimeout( flushTimer );
  flushTimer = undefined;
  if ( queued === 0 ) return;
  const batch = queue;
  queue = {};
  queued = 0;
  const body = JSON.stringify( batch );
  // A batch holding an error gets a few retries rather than being dropped on a
  // transient network failure. Others sync once to avoid amplifying
  // high-volume info logging.
  const maxAttempts = Object.values( batch ).some( e => e.level === "error" )
    ? 3
    : 1;
  for ( let attempt = 1; attempt <= maxAttempts; attempt += 1 ) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch( `${Config.CROP_LOG_FIREBASE_URL}/app_log.json`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body,
      } );
      if ( r.ok ) break;
    } catch {
      // Retry below, or give up once the loop runs out of attempts. Never
      // rethrow: we log to report errors, so failing to log must stay silent.
    }
    if ( attempt < maxAttempts ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise( resolve => { setTimeout( resolve, 500 * attempt ); } );
    }
  }
  Object.keys( batch ).forEach( key => pending.delete( key ) );
};

// Send what a previous launch queued but never got out
if ( !__DEV__ ) {
  pending.getAllKeys( ).forEach( key => {
    try {
      queue[key] = JSON.parse( pending.getString( key ) || "" );
      queued += 1;
    } catch {
      pending.delete( key );
    }
  } );
  flushLogs( );
}

// iOS may suspend or kill the app once it's backgrounded.
// Lines logged while backgrounded wait for a full batch, an error, or the next
// foreground, rather than waking the radio on a timer.
AppState.addEventListener( "change", state => {
  if ( state === "background" ) flushLogs( );
  if ( state === "active" && queued > 0 ) flushTimer ??= setTimeout( flushLogs, FLUSH_MS );
} );

// Custom transport that queues each log line as a push-ID child of
// {CROP_LOG_FIREBASE_URL}/app_log. The log DB allows unauthenticated
// writes, so no auth token is needed (same as the crop/brightness logs).
const firebaseLogTransport: transportFunctionType<firebaseLogTransportOptions> = props => {
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
    // First, so an extra key like `level` can't overwrite the entry's own
    ...( extra
      ? redactExtra( extra )
      : {} ),
    timestamp: new Date( ).toISOString( ),
    level: props.level.text,
    extension: props.extension,
    // commit lets a log line be traced back to the exact code that produced it
    commit: APP_COMMIT,
    message: redact( message ),
    ...( error?.stack
      ? { stack: redact( error.stack ) }
      : {} ),
  };

  const id = pushId( );
  queue[id] = entry;
  queued += 1;
  pending.set( id, JSON.stringify( entry ) );
  // Errors go out at once, with whatever is queued: they're the entries we
  // most need, and the one before a crash would otherwise die in the queue.
  if ( props.level.text === "error" || queued >= MAX_BATCH ) {
    flushLogs( );
  } else if ( AppState.currentState !== "background" ) {
    flushTimer ??= setTimeout( flushLogs, FLUSH_MS );
  }
};

export { default as enhanceLoggerWithExtra } from "./enhanceLoggerWithExtra";

export default firebaseLogTransport;
