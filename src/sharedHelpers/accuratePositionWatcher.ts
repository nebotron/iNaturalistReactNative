import type {
  GeolocationError,
  GeolocationResponse,
} from "@react-native-community/geolocation";
import { log } from "sharedHelpers/logger";

// Please don't change this to an aliased path or the e2e mock will not get
// used in our e2e tests on Github Actions
import { clearWatch, watchPosition } from "./geolocationWrapper";

const logger = log.extend( "accuratePositionWatcher" );

export interface UserLocation {
  latitude: number;
  longitude: number;
  positional_accuracy: number;
  altitude: number | null;
  altitudinal_accuracy: number | null;
}

// Accuracy, in meters, that's good enough to stop burning the GPS radio on
export const TARGET_POSITIONAL_ACCURACY = 10;
// The OS hands a brand new client its last known fix straight away, and that
// can be an old one from somewhere else entirely, so ignore the stale ones.
const MAX_POSITION_AGE_MS = 60_000;
// How long the most accurate fix we've seen stays authoritative. After that a
// newer but less accurate fix wins, because the user has probably moved.
const BEST_FIX_TTL_MS = 20_000;
// How recent an already-accurate fix has to be for a caller to reuse it
// outright instead of waiting for a new one.
const FRESH_FIX_MAX_AGE_MS = 5_000;
// How long to keep waiting for an accurate fix before settling for the best
// one we've seen. Kept under the 10s one-shot timeout this replaced so we
// never make the caller wait longer than it used to.
const ACCURACY_DEADLINE_MS = 6_000;

const geolocationOptions = {
  distanceFilter: 0,
  enableHighAccuracy: true,
  maximumAge: 0,
};

interface Listener {
  onLocation: ( location: UserLocation ) => void;
  onError?: ( ) => void;
}

// One watch for the whole app: the OS drives a single location manager, so
// overlapping watches would just fight over its options.
let watchId: number | null = null;
let listeners: Listener[] = [];
let bestFix: { location: UserLocation; receivedAt: number } | null = null;

const positionToUserLocation = ( position: GeolocationResponse ): UserLocation => ( {
  latitude: position.coords.latitude,
  longitude: position.coords.longitude,
  positional_accuracy: position.coords.accuracy,
  altitude: position.coords.altitude,
  altitudinal_accuracy: position.coords.altitudeAccuracy,
} );

// GPS accuracy fluctuates, it doesn't only improve, so a fix only replaces the
// current best if it's at least as accurate - otherwise a good fix gets thrown
// away as soon as a mediocre one lands on top of it.
const isBetterThanBestFix = ( location: UserLocation ) => {
  if ( !bestFix ) return true;
  if ( Date.now( ) - bestFix.receivedAt > BEST_FIX_TTL_MS ) return true;
  return location.positional_accuracy <= bestFix.location.positional_accuracy;
};

// Nothing has ever recorded what the OS actually delivers, so we've had to
// reason about GPS convergence from the CoreLocation docs rather than from
// this app's own data. Log the accuracy of each fix until one is good enough,
// then go quiet so a long camera session doesn't flood the log.
const MAX_LOGGED_FIXES = 8;
let watchStartedAt = 0;
let loggedFixes = 0;
let doneLogging = false;

const logFix = ( position: GeolocationResponse, outcome: string ) => {
  if ( doneLogging || loggedFixes >= MAX_LOGGED_FIXES ) return;
  loggedFixes += 1;
  logger.infoWithExtra( "position fix", {
    fixNumber: loggedFixes,
    accuracy: position.coords.accuracy,
    // when this fix arrived relative to the watch starting
    msSinceWatchStart: Date.now( ) - watchStartedAt,
    // how old the fix itself is, which is what gives away a cached one
    fixAgeMs: Date.now( ) - position.timestamp,
    outcome,
  } );
  if ( outcome === "used" && position.coords.accuracy <= TARGET_POSITIONAL_ACCURACY ) {
    doneLogging = true;
  }
};

const handlePosition = ( position: GeolocationResponse ) => {
  const location = positionToUserLocation( position );
  let outcome = "used";
  if ( Date.now( ) - position.timestamp > MAX_POSITION_AGE_MS ) {
    outcome = "stale";
  } else if ( position.coords.accuracy <= 0 ) {
    // CoreLocation reports a negative accuracy when it couldn't actually
    // determine the position, and we don't want that in positional_accuracy
    outcome = "invalid";
  } else if ( !isBetterThanBestFix( location ) ) {
    outcome = "worse";
  }
  logFix( position, outcome );
  if ( outcome !== "used" ) return;
  bestFix = { location, receivedAt: Date.now( ) };
  listeners.forEach( listener => listener.onLocation( location ) );
};

const stopWatch = ( ) => {
  if ( watchId === null ) return;
  clearWatch( watchId );
  watchId = null;
};

const handleError = ( error: GeolocationError ) => {
  console.warn( "accuratePositionWatcher error:", error );
  stopWatch( );
  listeners.forEach( listener => listener.onError?.( ) );
};

const startWatch = ( ) => {
  if ( watchId !== null ) return;
  watchStartedAt = Date.now( );
  loggedFixes = 0;
  doneLogging = false;
  watchId = watchPosition( handlePosition, handleError, geolocationOptions );
};

// Adds a listener and returns a function that removes it. The watch runs for
// as long as at least one listener wants it.
export const subscribeToPosition = ( listener: Listener ) => {
  listeners = listeners.concat( listener );
  startWatch( );
  return ( ) => {
    listeners = listeners.filter( existing => existing !== listener );
    if ( listeners.length === 0 ) stopWatch( );
  };
};

// The most accurate fix we've seen, as long as it's recent enough to still
// describe where the user is.
const getBestFixWithin = ( maxAgeMs: number ): UserLocation | null => {
  if ( !bestFix ) return null;
  if ( Date.now( ) - bestFix.receivedAt > maxAgeMs ) return null;
  return bestFix.location;
};

// A fix recent and accurate enough that a caller can use it as-is instead of
// waiting on a new one.
export const getRecentAccurateFix = (
  maxAgeMs: number = FRESH_FIX_MAX_AGE_MS,
): UserLocation | null => {
  const location = getBestFixWithin( maxAgeMs );
  if ( !location ) return null;
  if ( location.positional_accuracy > TARGET_POSITIONAL_ACCURACY ) return null;
  return location;
};

// Keeps the location radio warm, e.g. while the camera is open, so the fix a
// photo gets geotagged with has had time to converge.
export const startPositionWarmup = ( ) => subscribeToPosition( { onLocation: ( ) => {} } );

// Watch until a fix is accurate enough or we run out of time, then hand back
// the most accurate fix we saw. A single getCurrentPosition can't do this: it
// resolves with whichever fix arrives first, and the first one is the coarse
// network or cached fix the OS produces before the GPS has converged.
export const waitForAccuratePosition = (
  { timeout = ACCURACY_DEADLINE_MS }: { timeout?: number } = { },
): Promise<UserLocation | null> => new Promise( resolve => {
  const alreadyAccurate = getRecentAccurateFix( );
  if ( alreadyAccurate ) {
    resolve( alreadyAccurate );
    return;
  }

  let settled = false;
  let unsubscribe: ( ( ) => void ) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = ( location: UserLocation | null ) => {
    if ( settled ) return;
    settled = true;
    if ( timer ) clearTimeout( timer );
    unsubscribe?.( );
    resolve( location );
  };
  timer = setTimeout(
    ( ) => finish( getBestFixWithin( BEST_FIX_TTL_MS ) ),
    timeout,
  );

  const subscription = subscribeToPosition( {
    onLocation: location => {
      if ( location.positional_accuracy <= TARGET_POSITIONAL_ACCURACY ) finish( location );
    },
    onError: ( ) => finish( getBestFixWithin( BEST_FIX_TTL_MS ) ),
  } );
  if ( settled ) {
    subscription( );
  } else {
    unsubscribe = subscription;
  }
} );
