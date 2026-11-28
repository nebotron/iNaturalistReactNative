import CachedImage, { decodesWithFasterImage } from "components/SharedComponents/CachedImage";
import type { ForwardRefRenderFunction, ReactNode } from "react";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayoutChangeEvent, ViewProps } from "react-native";
import {
  NativeModules, requireNativeComponent, StyleSheet, View,
} from "react-native";
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

// The photo drawn with the same per-pixel brightness policy the crop editor
// bakes into the saved file (ImageCropper.m's applyBrightnessMultiplyBuffer),
// in place of the CSS brightness() filter, which clamps each channel on its
// own and so shifts the colour of bright pixels. Registered once here:
// requireNativeComponent throws when a name is registered twice.
const BrightenedImage = NativeModules.ImageCropper
  ? requireNativeComponent<ViewProps & {
    uri: string;
    brightness: number;
    // Brighten every pixel rather than a downsampled copy. Required in the
    // crop editor (see ImageCropView), which must never show anything but the
    // full-resolution photo.
    fullResolution: boolean;
  }>( "BrightenedImage" )
  : null;

export type SharedZoomableImageRef = ImageZoomRef & {
  readTransform: ( ) => ImageZoomTransform;
  applyTransform: ( transform: ImageZoomTransform ) => void;
  // The laid-out size of the zoom viewport, or null before the first layout.
  readViewSize: ( ) => { width: number; height: number } | null;
};

const styles = StyleSheet.create( {
  image: {
    flex: 1,
    overflow: "hidden",
  },
} );

type SharedZoomableImageProps = ImageZoomProps & {
  brightness?: number;
  fullResolution?: boolean;
  // Decode the photo at most this many pixels on the long side (see
  // CachedImage), e.g. a grid tile at its own size
  maxPixelSize?: number;
  // A sharper copy drawn over a maxPixelSize photo, for when it's shown (or
  // pinched) larger than that: true decodes the whole file, a number caps it.
  // A layer of its own so the photo underneath stays up while it decodes,
  // rather than the view blanking as it would on a new source.
  detail?: boolean | number;
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
    gestureLock,
    brightness = 1,
    fullResolution,
    maxPixelSize,
    detail = false,
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
  const viewSizeRef = useRef<{ width: number; height: number } | null>( null );
  // Once a photo's brightness has been adjusted, keep its brightened copy
  // mounted even when the slider passes back through 1, so it isn't decoded
  // again on the next tick.
  const [brightenedUri, setBrightenedUri] = useState<string | null>( null );
  if ( brightness !== 1 && uri && brightenedUri !== uri ) {
    setBrightenedUri( uri );
  }
  const showBrightened = !!BrightenedImage && !!uri && brightenedUri === uri;

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
    gestureLock,
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
    readViewSize: ( ) => viewSizeRef.current,
  } ), [applyTransform, reset, zoom] );

  const showDetail = !!detail && !!maxPixelSize && decodesWithFasterImage( uri, fullResolution );

  const handleLayout = ( event: LayoutChangeEvent ) => {
    const { width, height } = event.nativeEvent.layout;
    viewSizeRef.current = { width, height };
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
            // The brightened copy sits over it in the same transformed layer,
            // drawn aspect-fit like it, and is transparent until its first
            // render, so the plain photo shows while it decodes.
            <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
              <CachedImage
                testID={testID}
                className="w-full h-full"
                source={{ uri }}
                fullResolution={fullResolution}
                resizeMode="contain"
                onLoad={( { width, height } ) => {
                  onImageDimensionsChange?.( { width, height } );
                  onLoad?.( );
                }}
                maxPixelSize={maxPixelSize}
                onError={onError}
              />
              {showDetail && (
                <CachedImage
                  key={String( detail )}
                  className="absolute inset-0"
                  source={{ uri }}
                  fullResolution={fullResolution}
                  maxPixelSize={detail === true
                    ? undefined
                    : detail || undefined}
                  resizeMode="contain"
                />
              )}
              {showBrightened && BrightenedImage && (
                <BrightenedImage
                  style={StyleSheet.absoluteFill}
                  pointerEvents="none"
                  uri={uri}
                  brightness={brightness}
                  fullResolution={!!fullResolution}
                />
              )}
            </Animated.View>
          )}
      </View>
    </GestureDetector>
  );
};

export default forwardRef( SharedZoomableImage );
