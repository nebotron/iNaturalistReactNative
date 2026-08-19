import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { StyleSheet, Text } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import colors from "styles/tailwindColors";

const THUMB_SIZE = 20;
const TRACK_HEIGHT = 4;
const ROW_HEIGHT = 36;

// Drag gain as a function of how far the finger has strayed from the track,
// mirroring iOS scrubbing: the slider keeps its full 0..1 range, but pulling
// away from the track spends more finger travel on less of that range, so the
// same span can be dialled in at up to 25x the resolution.
const PRECISION_TIERS = [
  { minDy: 150, factor: 0.04, label: "1/25" },
  { minDy: 80, factor: 0.1, label: "1/10" },
  { minDy: 32, factor: 0.25, label: "1/4" },
];

const tierForDy = ( dy: number ) => PRECISION_TIERS.find( tier => Math.abs( dy ) >= tier.minDy );

const clamp01 = ( value: number ) => Math.min( 1, Math.max( 0, value ) );

const styles = StyleSheet.create( {
  filled: {
    backgroundColor: colors.inatGreen,
    borderRadius: TRACK_HEIGHT / 2,
    height: TRACK_HEIGHT,
    left: 0,
    position: "absolute",
  },
  precision: {
    color: colors.white,
    fontSize: 10,
    position: "absolute",
    top: 0,
  },
  row: {
    flex: 1,
    height: ROW_HEIGHT,
    justifyContent: "center",
    marginLeft: 8,
    paddingHorizontal: THUMB_SIZE / 2,
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
}

// A slider with variable-precision dragging. Tapping seeks, as with the
// stock slider; dragging away from the track vertically slows the thumb down
// so fine adjustments are possible without shrinking the slider's range.
const FineSlider = ( {
  value,
  onChange,
  onComplete,
  accessibilityLabel,
  disabled = false,
  minimumValue = 0,
  maximumValue = 1,
}: Props ) => {
  const [trackWidth, setTrackWidth] = useState( 0 );
  const [dragging, setDragging] = useState( false );
  const [precisionLabel, setPrecisionLabel] = useState<string | null>( null );

  // The thumb is tracked as a 0..1 position along the track and converted to
  // the caller's value range only at the edges.
  const range = maximumValue - minimumValue;
  const toPos = useCallback(
    ( val: number ) => clamp01( range === 0
      ? 0
      : ( val - minimumValue ) / range ),
    [minimumValue, range],
  );
  const toValue = useCallback(
    ( position: number ) => minimumValue + position * range,
    [minimumValue, range],
  );

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
    setPos( clamped );
    onChange( toValue( clamped ) );
  }, [onChange, toValue] );

  const gesture = useMemo( ( ) => Gesture.Pan( )
    .enabled( !disabled && trackWidth > 0 )
    .minDistance( 0 )
    .runOnJS( true )
    .onStart( event => {
      setDragging( true );
      setPrecisionLabel( null );
      lastXRef.current = event.x;
      emit( ( event.x - THUMB_SIZE / 2 ) / trackWidth );
    } )
    .onUpdate( event => {
      const dx = event.x - lastXRef.current;
      lastXRef.current = event.x;
      const tier = tierForDy( event.translationY );
      setPrecisionLabel( tier?.label ?? null );
      emit( posRef.current + ( dx / trackWidth ) * ( tier?.factor ?? 1 ) );
    } )
    .onFinalize( ( ) => {
      setDragging( false );
      setPrecisionLabel( null );
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
        <View style={[styles.thumb, { left: thumbLeft }]} />
        {precisionLabel && (
          <Text style={[styles.precision, { left: thumbLeft }]}>
            {precisionLabel}
          </Text>
        )}
      </View>
    </GestureDetector>
  );
};

export default FineSlider;
