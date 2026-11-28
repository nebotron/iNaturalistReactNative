import { useEffect, useState } from "react";
import type { SharedValue } from "react-native-reanimated";

// Lets gestures in separate GestureDetectors exclude each other: on a screen
// that shares one lock, whichever gesture starts first owns the touch until it
// ends, and every other gesture on that lock ignores its touches meanwhile.
// The cropper uses it so a touch either pinches/pans the photo or drags one
// of the sliders, never both at once. 0 means nobody holds the lock.
export type GestureLock = SharedValue<number>;

let nextOwnerId = 1;

// A stable owner id for one gesture, released if the gesture's component
// unmounts while it still holds the lock (its onFinalize never runs then).
export const useGestureLockOwner = ( lock?: GestureLock ) => {
  const [id] = useState( ( ) => {
    const ownerId = nextOwnerId;
    nextOwnerId += 1;
    return ownerId;
  } );
  useEffect( ( ) => ( ) => {
    if ( lock?.get( ) === id ) lock.set( 0 );
  }, [id, lock] );
  return id;
};

export const isGestureLockHeldByOther = ( lock: GestureLock | undefined, id: number ) => {
  "worklet";

  if ( !lock ) return false;
  const owner = lock.get( );
  return owner !== 0 && owner !== id;
};

// Returns whether the gesture now owns the lock (always true without a lock).
export const claimGestureLock = ( lock: GestureLock | undefined, id: number ) => {
  "worklet";

  if ( !lock ) return true;
  if ( isGestureLockHeldByOther( lock, id ) ) return false;
  lock.set( id );
  return true;
};

export const releaseGestureLock = ( lock: GestureLock | undefined, id: number ) => {
  "worklet";

  if ( lock && lock.get( ) === id ) lock.set( 0 );
};
