import Slider from "@react-native-community/slider";
import classNames from "classnames";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import SharedZoomableImage from "components/MediaViewer/SharedZoomableImage";
import { INatIcon } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { StyleSheet } from "react-native";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";
import colors from "styles/tailwindColors";

// Zoom slider: exponential mapping so equal slider travel is equal zoom ratio.
// Slider position runs 0..1; scale runs MIN_ZOOM..MAX_ZOOM as MIN * (MAX/MIN)^pos.
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;
export const clampZoom = ( scale: number ) => Math.min( MAX_ZOOM, Math.max( MIN_ZOOM, scale ) );
export const zoomPosToScale = ( pos: number ) => MIN_ZOOM * ( MAX_ZOOM / MIN_ZOOM ) ** pos;
export const zoomScaleToPos = ( scale: number ) => Math.min(
  1,
  Math.max( 0, Math.log( clampZoom( scale ) / MIN_ZOOM ) / Math.log( MAX_ZOOM / MIN_ZOOM ) ),
);

const IDENTITY_TRANSFORM: ImageZoomTransform = {
  scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
};

const styles = StyleSheet.create( {
  image: { flex: 1 },
  slider: { flex: 1, height: 36, marginLeft: 8 },
} );

// Convert a normalized subject-detection crop into an image-zoom transform that
// frames the subject within a square viewport.
const cropToZoomTransform = (
  crop: NormalizedCrop,
  viewportSize: number,
  imageWidth: number,
  imageHeight: number,
): ImageZoomTransform => {
  const contain = computeContainRect( viewportSize, viewportSize, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) return IDENTITY_TRANSFORM;
  const center = viewportSize / 2;
  const cx = contain.left + ( crop.x + crop.w / 2 ) * contain.width;
  const cy = contain.top + ( crop.y + crop.h / 2 ) * contain.height;
  const scale = clampZoom( Math.min(
    viewportSize / ( crop.w * contain.width ),
    viewportSize / ( crop.h * contain.height ),
  ) );
  return {
    scale,
    translateX: 0,
    translateY: 0,
    focalX: ( center - cx ) * scale,
    focalY: ( center - cy ) * scale,
  };
};

export interface IdentifyPhotoHandle {
  applyZoom: ( scale: number ) => void;
  saveCrop: ( ) => void;
}

interface IdentifyPhotoProps {
  uri: string;
  displayUri?: string;
  size: number;
  brightness?: number;
  onSingleTap?: ( ) => void;
  onScaleChange: ( scale: number ) => void;
  onLoad?: ( ) => void;
  onError?: ( ) => void;
  testID?: string;
}

// A single subject-framed photo with one- or two-finger pan/zoom. The framed
// viewport is saved to the crop log (which syncs to Firebase) whenever a
// gesture or slider zoom ends. `uri` keys subject detection and crop
// persistence; `displayUri` (e.g. a gamma tone-mapped copy) is what's shown
// if it differs.
export const IdentifyPhoto = memo( forwardRef<IdentifyPhotoHandle, IdentifyPhotoProps>( ( {
  uri,
  displayUri,
  size,
  brightness,
  onSingleTap,
  onScaleChange,
  onLoad,
  onError,
  testID,
}, ref ) => {
  const imageRef = useRef<SharedZoomableImageRef | null>( null );
  const dimsRef = useRef<{ width: number; height: number } | null>( null );
  const appliedRef = useRef( false );
  const detection = useSubjectDetectionForUri( uri );

  const saveCrop = useCallback( ( ) => {
    const dims = dimsRef.current;
    if ( !imageRef.current || !dims ) return;
    const crop = imageZoomTransformToNormalizedCrop(
      dims.width,
      dims.height,
      size,
      size,
      size,
      imageRef.current.readTransform( ),
    );
    saveAnimalCrop( uri, crop );
  }, [size, uri] );

  // Rescale the image while keeping whatever is currently at the viewport
  // centre fixed there (rather than snapping back to the image centre).
  // Derived directly from the current transform (not by round-tripping
  // through a normalized crop), since the crop rectangle gets clamped to the
  // image bounds whenever the view is letterboxed -- e.g. by aspect ratio, or
  // by panning past the image edge -- which would otherwise throw off the
  // fixed point and make the image drift as the slider moves.
  const applyZoom = useCallback( ( scale: number ) => {
    const img = imageRef.current;
    if ( !img ) return;
    const current = img.readTransform( );
    if ( current.scale <= 0 ) {
      img.applyTransform( {
        scale, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
      } );
      return;
    }
    const centre = size / 2;
    const totalTx = current.translateX + current.focalX;
    const totalTy = current.translateY + current.focalY;
    const localX = centre - totalTx / current.scale;
    const localY = centre - totalTy / current.scale;
    img.applyTransform( {
      scale,
      translateX: 0,
      translateY: 0,
      focalX: ( centre - localX ) * scale,
      focalY: ( centre - localY ) * scale,
    } );
  }, [size] );

  useImperativeHandle(
    ref,
    ( ) => ( { applyZoom, saveCrop } ),
    [applyZoom, saveCrop],
  );

  // Frame the detected (or previously logged) subject once detection resolves.
  useEffect( ( ) => {
    if ( appliedRef.current || !detection || !imageRef.current ) return;
    imageRef.current.applyTransform( cropToZoomTransform(
      detection.crop,
      size,
      detection.imageWidth,
      detection.imageHeight,
    ) );
    appliedRef.current = true;
  }, [detection, size] );

  const handleInteractionEnd = useCallback( ( ) => {
    // Let the gesture's settling animation finish before reading the transform.
    setTimeout( saveCrop, 400 );
  }, [saveCrop] );

  return (
    <SharedZoomableImage
      ref={imageRef}
      uri={displayUri ?? uri}
      style={styles.image}
      brightness={brightness}
      minScale={MIN_ZOOM}
      maxScale={MAX_ZOOM}
      allowLetterboxPan
      isDoubleTapEnabled
      isSingleTapEnabled={!!onSingleTap}
      onSingleTap={onSingleTap}
      onScaleChange={onScaleChange}
      onInteractionEnd={handleInteractionEnd}
      onImageDimensionsChange={dims => { dimsRef.current = dims; }}
      onLoad={onLoad}
      onError={onError}
      testID={testID}
    />
  );
} ) );

IdentifyPhoto.displayName = "IdentifyPhoto";

interface ZoomBrightnessSlidersProps {
  zoomScale: number;
  brightnessStops: number;
  brightnessDisabled?: boolean;
  exposureStopsMin: number;
  exposureStopsMax: number;
  onZoomChange: ( pos: number ) => void;
  onZoomComplete: ( ) => void;
  onBrightnessChange: ( value: number ) => void;
  onBrightnessComplete: ( value: number ) => void;
  zoomAccessibilityLabel: string;
  brightnessAccessibilityLabel: string;
}

// The zoom + brightness sliders shown below a photo (not covering it).
export const ZoomBrightnessSliders = ( {
  zoomScale,
  brightnessStops,
  brightnessDisabled,
  exposureStopsMin,
  exposureStopsMax,
  onZoomChange,
  onZoomComplete,
  onBrightnessChange,
  onBrightnessComplete,
  zoomAccessibilityLabel,
  brightnessAccessibilityLabel,
}: ZoomBrightnessSlidersProps ) => (
  <View className="px-4 pt-1">
    <View className="flex-row items-center">
      <INatIcon name="magnifying-glass" size={18} color={colors.darkGray} />
      <Slider
        style={styles.slider}
        minimumValue={0}
        maximumValue={1}
        minimumTrackTintColor={colors.inatGreen}
        maximumTrackTintColor={colors.lightGray}
        thumbTintColor={colors.inatGreen}
        value={zoomScaleToPos( zoomScale )}
        onValueChange={onZoomChange}
        onSlidingComplete={onZoomComplete}
        tapToSeek
        accessibilityLabel={zoomAccessibilityLabel}
      />
    </View>
    {/* Off mode ignores the exposure slider entirely and always shows the
        original image, so disable it rather than let it silently do nothing. */}
    <View className={classNames( "flex-row items-center", { "opacity-50": brightnessDisabled } )}>
      <INatIcon name="sun" size={18} color={colors.darkGray} />
      <Slider
        style={styles.slider}
        disabled={brightnessDisabled}
        minimumValue={exposureStopsMin}
        maximumValue={exposureStopsMax}
        minimumTrackTintColor={colors.inatGreen}
        maximumTrackTintColor={colors.lightGray}
        thumbTintColor={colors.inatGreen}
        value={brightnessStops}
        onValueChange={onBrightnessChange}
        onSlidingComplete={onBrightnessComplete}
        tapToSeek
        accessibilityLabel={brightnessAccessibilityLabel}
      />
    </View>
  </View>
);
