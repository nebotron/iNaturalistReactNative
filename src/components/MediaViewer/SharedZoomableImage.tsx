import type { ForwardRefRenderFunction } from "react";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
} from "react-native-reanimated";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import type { ImageZoomTransformRefs } from "sharedHooks/imageZoom/readImageZoomTransform";
import readImageZoomTransform from "sharedHooks/imageZoom/readImageZoomTransform";
import type { ImageZoomProps, ImageZoomRef } from "sharedHooks/imageZoom/types";
import { useZoomable } from "sharedHooks/imageZoom/useZoomable";

export type SharedZoomableImageRef = ImageZoomRef & {
  readTransform: ( ) => ImageZoomTransform;
  applyTransform: ( transform: ImageZoomTransform ) => void;
};

const styles = StyleSheet.create( {
  image: {
    flex: 1,
  },
} );

type SharedZoomableImageProps = ImageZoomProps & {
  brightness?: number;
  onLongPress?: () => void;
  onScaleChange?: ( scale: number ) => void;
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
    brightness = 1,
    onLongPress,
    onScaleChange,
    onLoad,
    onError,
  },
  ref,
) => {
  const transformRef = useRef<ImageZoomTransformRefs | null>( null );

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
  } );

  useEffect( ( ) => {
    transformRef.current = transform;
  }, [transform] );

  useAnimatedReaction(
    ( ) => transform.scale.value,
    ( scale ) => {
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
  } ), [applyTransform, reset, zoom] );

  const longPressGesture = useMemo(
    () => onLongPress
      ? Gesture.LongPress().runOnJS( true ).onStart( onLongPress )
      : null,
    [onLongPress],
  );

  const composedGestures = useMemo(
    () => ( longPressGesture
      ? Gesture.Simultaneous( gestures, longPressGesture )
      : gestures ),
    [gestures, longPressGesture],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brightnessFilter: any = brightness !== 1 ? { filter: [{ brightness }] } : null;

  return (
    <GestureDetector gesture={composedGestures}>
      <Animated.Image
        testID={testID}
        style={[styles.image, style, animatedStyle, brightnessFilter]}
        source={{ uri }}
        resizeMode="contain"
        onLayout={onZoomableLayout}
        onLoad={onLoad}
        onError={onError}
      />
    </GestureDetector>
  );
};

export default forwardRef( SharedZoomableImage );
