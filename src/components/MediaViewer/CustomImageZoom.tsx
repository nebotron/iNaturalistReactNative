import type { MutableRefObject, Node, Ref } from "react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { CropPanContext } from "sharedHelpers/cropPanTranslateLimits";
import { normalizedCropToImageZoomTransform }
  from "sharedHelpers/normalizedCropToImageZoomTransform";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";

import type { SharedZoomableImageRef } from "./SharedZoomableImage";
import SharedZoomableImage from "./SharedZoomableImage";

export const IMAGE_ZOOM_MIN_SCALE = 0.5;
export const IMAGE_ZOOM_MAX_SCALE = 100;

// Fraction of the smaller viewport dimension the detected subject is framed to
// fill. Shared with MediaViewer's crop read-back so a freshly framed subject
// round-trips back to (almost) the same normalized crop when logged.
export const SUBJECT_CROP_FRAME_FRACTION = 0.8;

interface Props {
  uri: string;
  setZooming?: ( ) => void;
  selectedMediaIndex?: number;
  resetKey?: string | number;
  width?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  zoomRef?: Ref<SharedZoomableImageRef>;
  autoReset?: boolean;
  // When set, run subject detection on the URI and frame the image to the
  // detected subject once detection resolves (instead of resetting to the full
  // image). Reuses the same detection cache and framing helper as the Explore
  // grid and crop editor.
  autoDetectSubject?: boolean;
  // Canonical URL to run detection / crop-log lookup against, when it differs
  // from the (possibly tone-mapped) display `uri`. Defaults to `uri`.
  detectUri?: string;
  cropPanContext?: CropPanContext;
  brightness?: number;
  onLongPress?: () => void;
  onInteractionEnd?: () => void;
  onImageDimensionsChange?: ( dims: { width: number; height: number } ) => void;
  onLoad?: () => void;
  onError?: () => void;
  onScaleChange?: ( scale: number ) => void;
  onSwipeToClose?: () => void;
}

const CustomImageZoom = ( {
  uri,
  setZooming,
  selectedMediaIndex,
  resetKey,
  width,
  height,
  style,
  testID,
  zoomRef,
  autoReset = true,
  autoDetectSubject = false,
  detectUri,
  cropPanContext,
  brightness = 1,
  onLongPress,
  onInteractionEnd,
  onImageDimensionsChange,
  onLoad,
  onError,
  onScaleChange,
  onSwipeToClose,
}: Props ): Node => {
  const { screenWidth, screenHeight } = useDeviceOrientation( );
  // Keep an internal ref for programmatic reset/framing regardless of whether
  // the caller passes an object ref or a callback ref, then forward the
  // instance on to whichever the caller passed.
  const internalZoomRef = useRef<SharedZoomableImageRef | null>( null );
  const setZoomRef = useCallback( ( instance: SharedZoomableImageRef | null ) => {
    internalZoomRef.current = instance;
    if ( typeof zoomRef === "function" ) {
      zoomRef( instance );
    } else if ( zoomRef ) {
      ( zoomRef as MutableRefObject<SharedZoomableImageRef | null> ).current = instance;
    }
  }, [zoomRef] );

  const viewportWidth = width ?? screenWidth;
  const viewportHeight = height ?? screenHeight;

  const zoomStyle = useMemo( ( ) => ( [
    {
      height: viewportHeight,
      width: viewportWidth,
    },
    style,
  ] ), [style, viewportHeight, viewportWidth] );

  const detection = useSubjectDetectionForUri(
    autoDetectSubject
      ? ( detectUri ?? uri )
      : undefined,
  );

  // On mount and whenever the photo changes: if subject detection is enabled
  // and has resolved, frame the image to the detected subject; otherwise fall
  // back to the plain full-image reset. Reuses the shared crop→transform
  // helper and applyTransform ref path (same as the crop editor), so no new
  // framing math lives here. applyTransform only sets shared values, so it is
  // safe to call regardless of layout timing.
  useEffect( () => {
    const zoom = internalZoomRef.current;
    if ( !zoom ) return;
    if ( autoDetectSubject && detection ) {
      const cropSize = Math.min( viewportWidth, viewportHeight )
        * SUBJECT_CROP_FRAME_FRACTION;
      zoom.applyTransform( normalizedCropToImageZoomTransform(
        detection.imageWidth,
        detection.imageHeight,
        viewportWidth,
        viewportHeight,
        cropSize,
        detection.crop,
      ) );
    } else if ( autoReset ) {
      zoom.reset( );
    }
  }, [
    autoReset,
    autoDetectSubject,
    detection,
    resetKey,
    selectedMediaIndex,
    viewportWidth,
    viewportHeight,
  ] );

  return (
    <SharedZoomableImage
      ref={setZoomRef}
      testID={testID ?? `CustomImageZoom.${uri}`}
      uri={uri}
      style={zoomStyle}
      minScale={IMAGE_ZOOM_MIN_SCALE}
      maxScale={IMAGE_ZOOM_MAX_SCALE}
      isDoubleTapEnabled
      onInteractionStart={() => setZooming?.( true )}
      onInteractionEnd={() => {
        setZooming?.( false );
        onInteractionEnd?.( );
      }}
      cropPanContext={cropPanContext}
      onSwipeToClose={onSwipeToClose}
      brightness={brightness}
      onLongPress={onLongPress}
      onImageDimensionsChange={onImageDimensionsChange}
      onLoad={onLoad}
      onError={onError}
      onScaleChange={onScaleChange}
    />
  );
};

export default CustomImageZoom;
