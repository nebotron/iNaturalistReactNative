import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

export interface WatchOptions {
  interval?: number;
  fastestInterval?: number;
  timeout?: number;
  maximumAge?: number;
  enableHighAccuracy?: boolean;
  // Android: ~100 m from Wi-Fi and cell towers when enableHighAccuracy is off,
  // instead of the ~10 km of PRIORITY_LOW_POWER (patched into the library)
  balancedPowerAccuracy?: boolean;
  distanceFilter?: number;
  useSignificantChanges?: boolean;
}

interface NativeGeolocation {
  startObserving: ( options: WatchOptions ) => void;
  stopObserving: ( ) => void;
}

// Android only. @react-native-community/geolocation starts native updates with
// the options of the first watch alone, and every later watch shares them,
// whatever it asked for. With location history tracking running (a 2 minute,
// 50 m watch), the camera's precise watch only got history's sparse fixes; and
// when the camera's watch came first, history inherited continuous
// high-accuracy GPS for as long as it ran. So native updates are restarted with
// what all the active watches together need whenever one starts or stops: the
// most accurate and most frequent any of them asked for.
const activeWatchOptions = new Map<number, WatchOptions>( );
let appliedOptionsKey: string | null = null;

const minDefined = ( values: ( number | undefined )[] ) => {
  const defined = values.filter( ( v ): v is number => typeof v === "number" );
  return defined.length
    ? Math.min( ...defined )
    : undefined;
};

export const mergeWatchOptions = ( watches: WatchOptions[] ): WatchOptions => {
  const merged: WatchOptions = {
    enableHighAccuracy: watches.some( w => w.enableHighAccuracy ),
    balancedPowerAccuracy: watches.some( w => w.balancedPowerAccuracy ),
    // A watch that leaves these out gets the library's defaults (10 s, 100 m)
    interval: minDefined( watches.map( w => w.interval ?? 10000 ) ),
    fastestInterval: minDefined( watches.map( w => w.fastestInterval ) ),
    distanceFilter: minDefined( watches.map( w => w.distanceFilter ?? 100 ) ),
    maximumAge: minDefined( watches.map( w => w.maximumAge ) ),
  };
  return Object.fromEntries(
    Object.entries( merged ).filter( ( [, value] ) => value !== undefined ),
  ) as WatchOptions;
};

const nativeGeolocation = ( ): NativeGeolocation | null => (
  ( TurboModuleRegistry.get( "RNCGeolocation" ) as NativeGeolocation | null )
  ?? ( NativeModules.RNCGeolocation as NativeGeolocation | undefined )
  ?? null
);

const applyMergedWatchOptions = ( ) => {
  if ( activeWatchOptions.size === 0 ) {
    // The library stopped native updates itself with the last watch
    appliedOptionsKey = null;
    return;
  }
  const merged = mergeWatchOptions( [...activeWatchOptions.values( )] );
  const key = JSON.stringify( merged );
  if ( key === appliedOptionsKey ) return;
  const native = nativeGeolocation( );
  if ( !native ) return;
  // startObserving alone would leave the previous request running
  native.stopObserving( );
  native.startObserving( merged );
  appliedOptionsKey = key;
};

// Call after the library's watchPosition returns watchID
export const watchStarted = ( watchID: number, options: WatchOptions = {} ) => {
  if ( Platform.OS !== "android" ) return;
  if ( activeWatchOptions.size === 0 ) {
    // The library started native updates with exactly these options
    appliedOptionsKey = JSON.stringify( mergeWatchOptions( [options] ) );
  }
  activeWatchOptions.set( watchID, options );
  applyMergedWatchOptions( );
};

// Call after the library's clearWatch
export const watchCleared = ( watchID: number ) => {
  if ( Platform.OS !== "android" ) return;
  activeWatchOptions.delete( watchID );
  applyMergedWatchOptions( );
};
