import type { UseZoomableProps } from "./types";
import { useGestures } from "./useGestures";
import { useZoomableHandle } from "./useZoomableHandle";
import { useZoomableLayout } from "./useZoomableLayout";

export const useZoomable = ( {
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
  ref,
  cropPanContext,
}: UseZoomableProps ) => {
  const {
    width, height, center, onZoomableLayout,
  } = useZoomableLayout( {
    onLayout,
  } );
  const {
    animatedStyle,
    gestures,
    reset,
    zoom,
    applyTransform,
    transform,
  } = useGestures( {
    width,
    height,
    center,
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
    cropPanContext,
  } );
  useZoomableHandle( ref, reset, zoom, applyTransform );

  return {
    animatedStyle,
    gestures,
    onZoomableLayout,
    transform,
    reset,
    zoom,
    applyTransform,
  };
};
