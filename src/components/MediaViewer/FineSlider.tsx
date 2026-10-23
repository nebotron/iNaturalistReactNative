import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import colors from "styles/tailwindColors";

const THUMB_SIZE = 20;
const TRACK_HEIGHT = 4;
const ROW_HEIGHT = 36;
const TICK_HEIGHT = 12;

const clamp01 = ( value: number ) => Math.min( 1, Math.max( 0, value ) );

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
}

// A drag-only slider: the thumb moves by the finger's horizontal travel from
// wherever the drag starts, and tapping never changes the value.
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
}: Props ) => {
  const [trackWidth, setTrackWidth] = useState( 0 );
  const [dragging, setDragging] = useState( false );

  // The thumb is tracked as a 0..1 position along the track and converted to
  // the caller's value range only at the edges.
  const range = maximumValue - minimumValue;
  const toPos = useCallback(
    ( val: number ) => clamp01( range === 0
      ? 0
      : ( val - minimumValue ) / range ),
    [minimumValue, range],
  );
  // posRef holds the raw drag position; only what's shown and reported snaps,
  // so dragging on through the snap zone still escapes it.
  const toValue = useCallback( ( position: number ) => {
    const val = minimumValue + position * range;
    return snapValue !== undefined && Math.abs( val - snapValue ) < snapThreshold
      ? snapValue
      : val;
  }, [minimumValue, range, snapThreshold, snapValue] );

  const [pos, setPos] = useState( ( ) => toPos( value ) );
  const posRef = useRef( toPos( value ) );
  const lastXRef = useRef( 0 );

  // Follow the controlled value except while dragging, when the accumulated
  // position is authoritative (the parent's value is a rounded round-trip
  // through zoom scale and would otherwise fight the drag).
  useEffect( ( ) => {
    if ( dragging ) return;
    posRef.current = toPos( value );
    setPos( toPos( value ) );
  }, [dragging, toPos, value] );

  const emit = useCallback( ( next: number ) => {
    const clamped = clamp01( next );
    posRef.current = clamped;
    const val = toValue( clamped );
    setPos( toPos( val ) );
    onChange( val );
  }, [onChange, toPos, toValue] );

  const gesture = useMemo( ( ) => Gesture.Pan( )
    .enabled( !disabled && trackWidth > 0 )
    .minDistance( 0 )
    .runOnJS( true )
    .onStart( event => {
      setDragging( true );
      lastXRef.current = event.x;
    } )
    .onUpdate( event => {
      const dx = event.x - lastXRef.current;
      lastXRef.current = event.x;
      emit( posRef.current + dx / trackWidth );
    } )
    .onFinalize( ( ) => {
      setDragging( false );
      onComplete( toValue( posRef.current ) );
    } ), [disabled, emit, onComplete, toValue, trackWidth] );

  // Absolute children are laid out from the row's content edge, so this is
  // already inside the row's thumb-radius padding: the thumb centre lands on
  // the track position and never overflows the row.
  const thumbLeft = pos * trackWidth - THUMB_SIZE / 2;

  return (
    <GestureDetector gesture={gesture}>
      <View
        style={styles.row}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ min: 0, max: 100, now: Math.round( pos * 100 ) }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={event => {
          const step = event.nativeEvent.actionName === "increment"
            ? 0.02
            : -0.02;
          emit( posRef.current + step );
          onComplete( toValue( posRef.current ) );
        }}
      >
        <View
          style={styles.track}
          onLayout={event => setTrackWidth( event.nativeEvent.layout.width )}
        >
          <View style={[styles.filled, { width: pos * trackWidth }]} />
        </View>
        {snapValue !== undefined && (
          <View style={[styles.tick, { left: toPos( snapValue ) * trackWidth - 1 }]} />
        )}
        <View style={[styles.thumb, { left: thumbLeft }]} />
      </View>
    </GestureDetector>
  );
};

export default FineSlider;
