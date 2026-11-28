/* global requestAnimationFrame, cancelAnimationFrame */
import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { GestureLock } from "sharedHelpers/gestureLock";
import {
  claimGestureLock,
  releaseGestureLock,
  useGestureLockOwner,
} from "sharedHelpers/gestureLock";
import usePreventSwipeBack from "sharedHooks/usePreventSwipeBack";
import colors from "styles/tailwindColors";

const THUMB_SIZE = 20;
const TRACK_HEIGHT = 4;
const ROW_HEIGHT = 36;
const TICK_HEIGHT = 12;

const clamp01 = ( value: number ) => {
  "worklet";

  return Math.min( 1, Math.max( 0, value ) );
};

const styles = StyleSheet.create( {
  filled: {
    backgroundColor: colors.inatGreen,
    borderRadius: TRACK_HEIGHT / 2,
    height: TRACK_HEIGHT,
    left: 0,
    position: "absolute",
  },
  row: {
    flex: 1,
    height: ROW_HEIGHT,
    justifyContent: "center",
    marginLeft: 8,
    paddingHorizontal: THUMB_SIZE / 2,
  },
  tick: {
    backgroundColor: colors.white,
    height: TICK_HEIGHT,
    position: "absolute",
    top: ( ROW_HEIGHT - TICK_HEIGHT ) / 2,
    width: 2,
  },
  thumb: {
    backgroundColor: colors.inatGreen,
    borderRadius: THUMB_SIZE / 2,
    height: THUMB_SIZE,
    position: "absolute",
    top: ( ROW_HEIGHT - THUMB_SIZE ) / 2,
    width: THUMB_SIZE,
  },
  track: {
    backgroundColor: colors.lightGray,
    borderRadius: TRACK_HEIGHT / 2,
    height: TRACK_HEIGHT,
    justifyContent: "center",
  },
} );

interface Props {
  // Current value, within minimumValue..maximumValue.
  value: number;
  onChange: ( value: number ) => void;
  onComplete: ( value: number ) => void;
  accessibilityLabel: string;
  disabled?: boolean;
  minimumValue?: number;
  maximumValue?: number;
  // Values within snapThreshold of snapValue snap to it, marked with a tick.
  snapValue?: number;
  snapThreshold?: number;
  // Shared with other gestures on the screen so a touch drives only one of
  // them: while another holds it, this slider ignores drags.
  gestureLock?: GestureLock;
}

// A drag-only slider: the thumb moves by the finger's horizontal travel from
// wherever the drag starts, and tapping never changes the value.
//
// The drag runs on the UI thread so the thumb keeps up with the finger even
// while the JS thread is busy. onChange makes the host screen re-render (the
// exposure slider re-filters the photo), so it is called at most once a frame,
// with the latest value: touch events that arrive while a render is still
// running are merged instead of queuing a backlog of renders.
const FineSlider = ( {
  value,
  onChange,
  onComplete,
  accessibilityLabel,
  disabled = false,
  minimumValue = 0,
  maximumValue = 1,
  snapValue,
  snapThreshold = 0,
  gestureLock,
}: Props ) => {
  usePreventSwipeBack( !disabled );
  const [trackWidth, setTrackWidth] = useState( 0 );

  // The thumb is tracked as a 0..1 position along the track and converted to
  // the caller's value range only at the edges.
  const range = maximumValue - minimumValue;
  const toPos = useCallback( ( val: number ) => {
    "worklet";

    return clamp01( range === 0
      ? 0
      : ( val - minimumValue ) / range );
  }, [minimumValue, range] );
  // rawPos holds the raw drag position; only what's shown and reported snaps,
  // so dragging on through the snap zone still escapes it.
  const toValue = useCallback( ( position: number ) => {
    "worklet";

    const val = minimumValue + position * range;
    return snapValue !== undefined && Math.abs( val - snapValue ) < snapThreshold
      ? snapValue
      : val;
  }, [minimumValue, range, snapThreshold, snapValue] );
  // Where the thumb is drawn for a raw position: the snapped value's position.
  const shownPos = useCallback( ( position: number ) => {
    "worklet";

    return toPos( toValue( position ) );
  }, [toPos, toValue] );

  const rawPos = useSharedValue( toPos( value ) );
  const thumbPos = useSharedValue( toPos( value ) );
  const lastX = useSharedValue( 0 );
  const isDragging = useSharedValue( false );
  const trackWidthSV = useSharedValue( 0 );
  const lockOwnerId = useGestureLockOwner( gestureLock );
  // Whether the current drag owns the gesture lock and so may move the thumb.
  const ownsDrag = useSharedValue( false );

  // Follow the controlled value except while dragging, when the accumulated
  // position is authoritative (the parent's value is a rounded round-trip
  // through zoom scale and would otherwise fight the drag). The value the
  // drag ends on arrives after isDragging clears, so the thumb then settles
  // on it.
  useEffect( ( ) => {
    if ( isDragging.get( ) ) return;
    rawPos.set( toPos( value ) );
    thumbPos.set( toPos( value ) );
  }, [isDragging, rawPos, thumbPos, toPos, value] );

  // Latest callbacks, read when a frame flushes or a drag ends.
  const onChangeRef = useRef( onChange );
  const onCompleteRef = useRef( onComplete );
  useLayoutEffect( ( ) => {
    onChangeRef.current = onChange;
    onCompleteRef.current = onComplete;
  }, [onChange, onComplete] );
  const pendingRef = useRef<number | null>( null );
  const frameRef = useRef<number | null>( null );

  const flushChange = useCallback( ( ) => {
    frameRef.current = null;
    const next = pendingRef.current;
    if ( next === null ) return;
    pendingRef.current = null;
    onChangeRef.current( next );
  }, [] );

  const reportChange = useCallback( ( next: number ) => {
    pendingRef.current = next;
    if ( frameRef.current === null ) {
      frameRef.current = requestAnimationFrame( flushChange );
    }
  }, [flushChange] );

  const finishDrag = useCallback( ( final: number ) => {
    if ( frameRef.current !== null ) cancelAnimationFrame( frameRef.current );
    flushChange( );
    onCompleteRef.current( final );
  }, [flushChange] );

  useEffect( ( ) => ( ) => {
    if ( frameRef.current !== null ) cancelAnimationFrame( frameRef.current );
  }, [] );

  const handleTrackLayout = useCallback( ( width: number ) => {
    trackWidthSV.set( width );
    setTrackWidth( width );
  }, [trackWidthSV] );

  const gesture = useMemo( ( ) => Gesture.Pan( )
    .enabled( !disabled && trackWidth > 0 )
    .minDistance( 0 )
    .onStart( event => {
      const owns = claimGestureLock( gestureLock, lockOwnerId );
      ownsDrag.set( owns );
      if ( !owns ) return;
      isDragging.set( true );
      lastX.set( event.x );
    } )
    .onUpdate( event => {
      if ( !ownsDrag.get( ) ) return;
      const dx = event.x - lastX.get( );
      lastX.set( event.x );
      const next = clamp01( rawPos.get( ) + dx / trackWidthSV.get( ) );
      if ( next === rawPos.get( ) ) return;
      rawPos.set( next );
      thumbPos.set( shownPos( next ) );
      scheduleOnRN( reportChange, toValue( next ) );
    } )
    .onFinalize( ( ) => {
      if ( !ownsDrag.get( ) ) return;
      ownsDrag.set( false );
      releaseGestureLock( gestureLock, lockOwnerId );
      isDragging.set( false );
      scheduleOnRN( finishDrag, toValue( rawPos.get( ) ) );
    } ), [
    disabled,
    finishDrag,
    gestureLock,
    isDragging,
    lastX,
    lockOwnerId,
    ownsDrag,
    rawPos,
    reportChange,
    shownPos,
    thumbPos,
    toValue,
    trackWidth,
    trackWidthSV,
  ] );

  // Absolute children are laid out from the row's content edge, so this is
  // already inside the row's thumb-radius padding: the thumb centre lands on
  // the track position and never overflows the row.
  const thumbStyle = useAnimatedStyle( ( ) => ( {
    left: thumbPos.get( ) * trackWidthSV.get( ) - THUMB_SIZE / 2,
  } ) );
  const filledStyle = useAnimatedStyle( ( ) => ( {
    width: thumbPos.get( ) * trackWidthSV.get( ),
  } ) );

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.row}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min: 0, max: 100, now: Math.round( toPos( value ) * 100 ) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={event => {
          const step = event.nativeEvent.actionName === "increment"
            ? 0.02
            : -0.02;
          const next = clamp01( rawPos.get( ) + step );
          rawPos.set( next );
          thumbPos.set( shownPos( next ) );
          onChange( toValue( next ) );
          onComplete( toValue( next ) );
        }}
      >
        <View
          style={styles.track}
          onLayout={event => handleTrackLayout( event.nativeEvent.layout.width )}
        >
          <Animated.View style={[styles.filled, filledStyle]} />
        </View>
        {snapValue !== undefined && (
          <View style={[styles.tick, { left: toPos( snapValue ) * trackWidth - 1 }]} />
        )}
        <Animated.View style={[styles.thumb, thumbStyle]} />
      </View>
    </GestureDetector>
  );
};

export default FineSlider;
