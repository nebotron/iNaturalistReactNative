import type { ForwardRefRenderFunction } from "react";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
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

const SharedZoomableImage: ForwardRefRenderFunction<
  SharedZoomableImageRef,
  ImageZoomProps
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

  return (
    <GestureDetector gesture={gestures}>
      <Animated.Image
        testID={testID}
        style={[styles.image, style, animatedStyle]}
        source={{ uri }}
        resizeMode="contain"
        onLayout={onZoomableLayout}
      />
    </GestureDetector>
  );
};

export default forwardRef( SharedZoomableImage );
