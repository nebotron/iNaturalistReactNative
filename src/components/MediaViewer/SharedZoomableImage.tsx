import CachedImage from "components/SharedComponents/CachedImage";
import type { ForwardRefRenderFunction, ReactNode } from "react";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
} from "react-native-reanimated";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";
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
  brightness?: number;
  onLongPress?: () => void;
  onScaleChange?: ( scale: number ) => void;
  onImageDimensionsChange?: ( dims: { width: number; height: number } ) => void;
  onLoad?: () => void;
  onError?: () => void;
  // Optional custom image renderer. When provided it is drawn inside the
  // zoom-transformed layer instead of the default CachedImage, letting callers
  // use a different image backend while sharing the same gesture engine.
  renderImage?: () => ReactNode;
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
    renderImage,
  },
  ref,
) => {
  const transformRef = useRef<ImageZoomTransformRefs | null>( null );
  const [viewSize, setViewSize] = useState<{ width: number; height: number } | null>( null );
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>( null );

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

  // Applied as a plain (non-reanimated) style: reanimated's useAnimatedStyle
  // does not render the `filter` prop, so an animated brightness silently does
  // nothing. Driving it from the prop re-renders the image each change instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brightnessFilter: any = brightness !== 1
    ? { filter: [{ brightness }] }
    : null;

  // iOS renders a brightness filter as a multiply-blend layer covering the
  // whole filtered view. With the image at absoluteFill and resizeMode
  // "contain", that layer also covers the letterbox bars, tinting whatever
  // shows through them (e.g. the white screen background on Explore >
  // Identify) so the padding no longer matches the background. Sizing the
  // image to its contain rect -- same pixels, since that rect is centered in
  // the view -- keeps the filter on the photo alone.
  const containRect = brightnessFilter && viewSize && imageSize
    ? computeContainRect( viewSize.width, viewSize.height, imageSize.width, imageSize.height )
    : null;
  const imageLayoutStyle = containRect && containRect.width > 0 && containRect.height > 0
    ? {
      position: "absolute" as const,
      left: containRect.left,
      top: containRect.top,
      width: containRect.width,
      height: containRect.height,
    }
    : StyleSheet.absoluteFill;

  const handleLayout = ( event: LayoutChangeEvent ) => {
    const { width, height } = event.nativeEvent.layout;
    setViewSize( prev => (
      prev?.width === width && prev?.height === height
        ? prev
        : { width, height }
    ) );
    onZoomableLayout( event );
  };

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
      <View style={[styles.image, style]} onLayout={handleLayout}>
        {renderImage
          ? (
            <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
              {renderImage( )}
            </Animated.View>
          )
          : (
            // CachedImage rather than Animated.Image so full-screen photos,
            // the IDing game and the crop editor read from the same disk cache
            // as the grids that prefetched them. The transform stays on this
            // wrapper because CachedImage renders a native view underneath.
            <Animated.View
              style={[imageLayoutStyle, animatedStyle, brightnessFilter]}
            >
              <CachedImage
                testID={testID}
                className="w-full h-full"
                source={{ uri }}
                resizeMode="contain"
                onLoad={( { width, height } ) => {
                  setImageSize( prev => (
                    prev?.width === width && prev?.height === height
                      ? prev
                      : { width, height }
                  ) );
                  onImageDimensionsChange?.( { width, height } );
                  onLoad?.( );
                }}
                onError={onError}
              />
            </Animated.View>
          )}
      </View>
    </GestureDetector>
  );
};

export default forwardRef( SharedZoomableImage );
