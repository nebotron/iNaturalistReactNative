import type { ForwardRefRenderFunction } from "react";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import type { ImageZoomTransformRefs } from "sharedHooks/imageZoom/readImageZoomTransform";
import readImageZoomTransform from "sharedHooks/imageZoom/readImageZoomTransform";
import type { ImageZoomProps, ImageZoomRef } from "sharedHooks/imageZoom/types";
import { useZoomable } from "sharedHooks/imageZoom/useZoomable";

export type SharedZoomableImageRef = ImageZoomRef & {
  readTransform: ( ) => ImageZoomTransform;
  applyTransform: ( transform: ImageZoomTransform ) => void;
  setBrightness: ( value: number ) => void;
};

const styles = StyleSheet.create( {
  image: {
    flex: 1,
    overflow: "hidden",
  },
} );

type SharedZoomableImageProps = ImageZoomProps & {
  brightness?: number;
  onLongPress?: () => void;
  onScaleChange?: ( scale: number ) => void;
  onImageDimensionsChange?: ( dims: { width: number; height: number } ) => void;
  onLoad?: () => void;
  onError?: () => void;
};

const SharedZoomableImage: ForwardRefRenderFunction<
  SharedZoomableImageRef,
  SharedZoomableImageProps
> = (
  {
    uri = "",
    minScale,
    maxScale,
    scale,
    doubleTapScale,
    maxPanPointers,
    isPanEnabled,
    isSingleFingerPanEnabled,
    isPinchEnabled,
    isSingleTapEnabled,
    isDoubleTapEnabled,
    onInteractionStart,
    onInteractionEnd,
    onPinchStart,
    onPinchEnd,
    onPanStart,
    onPanEnd,
    onSingleTap,
    onDoubleTap,
    onProgrammaticZoom,
    onResetAnimationEnd,
    onLayout,
    style = {},
    testID,
    cropPanContext,
    onSwipeToClose,
    allowLetterboxPan,
    brightness = 1,
    onLongPress,
    onScaleChange,
    onImageDimensionsChange,
    onLoad,
    onError,
  },
  ref,
) => {
  const transformRef = useRef<ImageZoomTransformRefs | null>( null );
  const brightnessSV = useSharedValue( brightness );

  const {
    animatedStyle,
    gestures,
    onZoomableLayout,
    transform,
    reset,
    zoom,
    applyTransform,
  } = useZoomable( {
    minScale,
    maxScale,
    scale,
    doubleTapScale,
    maxPanPointers,
    isPanEnabled,
    isSingleFingerPanEnabled,
    isPinchEnabled,
    isSingleTapEnabled,
    isDoubleTapEnabled,
    onInteractionStart,
    onInteractionEnd,
    onPinchStart,
    onPinchEnd,
    onPanStart,
    onPanEnd,
    onSingleTap,
    onDoubleTap,
    onProgrammaticZoom,
    onResetAnimationEnd,
    onLayout,
    ref: undefined,
    cropPanContext,
    onSwipeToClose,
    allowLetterboxPan,
  } );

  useEffect( ( ) => {
    transformRef.current = transform;
  }, [transform] );

  // Kept on a shared value (rather than only a JS style prop) so a caller
  // driving rapid updates -- e.g. a slider dragged live -- can bypass a full
  // React re-render per tick via setBrightness, exactly like applyTransform
  // does for zoom/pan.
  useEffect( ( ) => {
    brightnessSV.value = brightness;
  }, [brightness, brightnessSV] );

  const brightnessAnimatedStyle = useAnimatedStyle( ( ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const style: any = brightnessSV.value !== 1
      ? { filter: [{ brightness: brightnessSV.value }] }
      : {};
    return style;
  } );

  useAnimatedReaction(
    ( ) => transform.scale.value,
    scale => {
      if ( onScaleChange ) {
        runOnJS( onScaleChange )( scale );
      }
    },
    [onScaleChange],
  );

  useImperativeHandle( ref, ( ) => ( {
    reset,
    zoom,
    applyTransform,
    readTransform: ( ) => {
      if ( !transformRef.current ) {
        return {
          scale: 1,
          translateX: 0,
          translateY: 0,
          focalX: 0,
          focalY: 0,
        };
      }
      return readImageZoomTransform( transformRef.current );
    },
    setBrightness: ( value: number ) => {
      brightnessSV.value = value;
    },
  } ), [applyTransform, brightnessSV, reset, zoom] );

  const longPressGesture = useMemo(
    () => ( onLongPress
      ? Gesture.LongPress().runOnJS( true ).onStart( onLongPress )
      : null ),
    [onLongPress],
  );

  const composedGestures = useMemo(
    () => ( longPressGesture
      ? Gesture.Simultaneous( gestures, longPressGesture )
      : gestures ),
    [gestures, longPressGesture],
  );

  // The GestureDetector must attach to a view that is NOT transformed: gesture
  // coordinates (e.g. pinch focalX/focalY) are reported relative to the attached
  // view, so attaching to the transformed image itself creates a feedback loop
  // that makes two-finger panning lag far behind the fingers.
  return (
    <GestureDetector gesture={composedGestures}>
      <View style={[styles.image, style]} onLayout={onZoomableLayout}>
        <Animated.Image
          testID={testID}
          style={[StyleSheet.absoluteFill, animatedStyle, brightnessAnimatedStyle]}
          source={{ uri }}
          resizeMode="contain"
          onLoad={event => {
            const { width, height } = event.nativeEvent.source;
            onImageDimensionsChange?.( { width, height } );
            onLoad?.( );
          }}
          onError={onError}
        />
      </View>
    </GestureDetector>
  );
};

export default forwardRef( SharedZoomableImage );
