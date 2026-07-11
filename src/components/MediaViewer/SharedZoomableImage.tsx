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
    overflow: "hidden",
  },
} );

type SharedZoomableImageProps = ImageZoomProps & {
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
    onLongPress,
    onScaleChange,
    onImageDimensionsChange,
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
    onSwipeToClose,
  } );

  useEffect( ( ) => {
    transformRef.current = transform;
  }, [transform] );

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
  } ), [applyTransform, reset, zoom] );

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
          style={[StyleSheet.absoluteFill, animatedStyle]}
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
