import type { Node, Ref } from "react";
import React, {
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { CropPanContext } from "sharedHelpers/cropPanTranslateLimits";
import useDeviceOrientation from "sharedHooks/useDeviceOrientation";

import type { SharedZoomableImageRef } from "./SharedZoomableImage";
import SharedZoomableImage from "./SharedZoomableImage";

export const IMAGE_ZOOM_MIN_SCALE = 0.5;
export const IMAGE_ZOOM_MAX_SCALE = 50;

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
  cropPanContext?: CropPanContext;
  brightness?: number;
  onLongPress?: () => void;
  onInteractionEnd?: () => void;
  onImageDimensionsChange?: ( dims: { width: number; height: number } ) => void;
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
  cropPanContext,
  brightness = 1,
  onLongPress,
  onInteractionEnd,
  onImageDimensionsChange,
  onScaleChange,
  onSwipeToClose,
}: Props ): Node => {
  const { screenWidth, screenHeight } = useDeviceOrientation( );
  const internalZoomRef = useRef<SharedZoomableImageRef>( null );
  const imageZoomRef = zoomRef ?? internalZoomRef;

  const zoomStyle = useMemo( ( ) => ( [
    {
      height: height ?? screenHeight,
      width: width ?? screenWidth,
    },
    style,
  ] ), [height, screenHeight, screenWidth, style, width] );

  useEffect( () => {
    if ( autoReset ) {
      imageZoomRef.current?.reset( );
    }
  }, [autoReset, imageZoomRef, resetKey, selectedMediaIndex] );

  return (
    <SharedZoomableImage
      ref={imageZoomRef}
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
      onScaleChange={onScaleChange}
    />
  );
};

export default CustomImageZoom;
