import { FasterImageView } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { saveAnimalCrop } from "sharedHelpers/animalCropLog";
import type { CropPanContext } from "sharedHelpers/cropPanTranslateLimits";
import { computeCropPanTranslateLimits } from "sharedHelpers/cropPanTranslateLimits";
import type { ImageZoomTransform } from "sharedHelpers/imageZoomTransformToCrop";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect } from "sharedHelpers/normalizedCropTypes";
import type { ImageZoomTransformRefs } from "sharedHooks/imageZoom/readImageZoomTransform";
import readImageZoomTransform from "sharedHooks/imageZoom/readImageZoomTransform";
import { useZoomable } from "sharedHooks/imageZoom/useZoomable";

const MAX_SCALE = 10;

interface Props {
  uri: string;
  imageWidth: number;
  imageHeight: number;
  initialCrop: NormalizedCrop;
  size: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  brightnessStyle?: any;
}

// Builds a transform that frames a normalized crop centered in the square tile.
// scale is at least coverScale so the image always fills the tile (no letterbox
// bars, and the crop clamping never has to snap an edge into view).
const frameCropTransform = (
  crop: NormalizedCrop,
  size: number,
  imageWidth: number,
  imageHeight: number,
  coverScale: number,
): ImageZoomTransform => {
  const contain = computeContainRect( size, size, imageWidth, imageHeight );
  if ( contain.width <= 0 || contain.height <= 0 ) {
    return {
      scale: 1, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
    };
  }
  const fitCropScale = Math.min(
    size / ( crop.w * contain.width ),
    size / ( crop.h * contain.height ),
  );
  const scale = Math.min( MAX_SCALE, Math.max( coverScale, fitCropScale ) );
  const center = size / 2;
  const cropCenterX = contain.left + ( crop.x + crop.w / 2 ) * contain.width;
  const cropCenterY = contain.top + ( crop.y + crop.h / 2 ) * contain.height;
  return {
    scale,
    translateX: 0,
    translateY: 0,
    focalX: ( center - cropCenterX ) * scale,
    focalY: ( center - cropCenterY ) * scale,
  };
};

// Renders an Explore-grid photo cropped to the detected subject, with a
// two-finger pinch/pan that reuses the shared image-zoom engine so the gesture
// behaves identically to the crop editor, MediaViewer and IDing game (smooth,
// UI-thread, image tracks the fingers). Single-finger panning is disabled so
// one finger scrolls the list; two fingers are required to pan or zoom.
const ObsImageZoomable = ( {
  uri,
  imageWidth,
  imageHeight,
  initialCrop,
  size,
  brightnessStyle,
}: Props ) => {
  const transformRef = useRef<ImageZoomTransformRefs | null>( null );

  // Minimum zoom at which the image still fills the square tile. Also the floor
  // that keeps the crop strictly inside the image, so panning never reveals a
  // letterbox edge.
  const coverScale = useMemo( ( ) => {
    const contain = computeContainRect( size, size, imageWidth, imageHeight );
    if ( contain.width <= 0 || contain.height <= 0 ) return 1;
    return size / Math.min( contain.width, contain.height );
  }, [size, imageWidth, imageHeight] );

  // On gesture end, immediately log the framed region as a ground-truth crop.
  const handleInteractionEnd = useCallback( ( ) => {
    if ( !transformRef.current ) return;
    const crop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      size,
      size,
      size,
      readImageZoomTransform( transformRef.current ),
    );
    saveAnimalCrop( uri, crop );
  }, [uri, imageWidth, imageHeight, size] );

  const cropPanContext: CropPanContext = {
    imageWidth,
    imageHeight,
    viewportWidth: size,
    viewportHeight: size,
    cropSize: size,
  };

  const {
    animatedStyle,
    gestures,
    onZoomableLayout,
    transform,
    applyTransform,
  } = useZoomable( {
    minScale: coverScale,
    maxScale: MAX_SCALE,
    isPinchEnabled: true,
    isSingleFingerPanEnabled: false,
    isDoubleTapEnabled: false,
    isSingleTapEnabled: false,
    cropPanContext,
    onInteractionEnd: handleInteractionEnd,
    ref: null,
  } );

  useEffect( ( ) => {
    transformRef.current = transform;
  }, [transform] );

  // Frame the detected (or previously logged) crop once the layout and image
  // dimensions are known. Applied a single time per photo; the engine keeps
  // the live transform across subsequent gestures.
  const appliedRef = useRef( false );
  useEffect( ( ) => {
    if ( appliedRef.current ) return;
    if ( size <= 0 || imageWidth <= 0 || imageHeight <= 0 ) return;
    const framed = frameCropTransform( initialCrop, size, imageWidth, imageHeight, coverScale );
    // Clamp the framing so the image always covers the tile even when the subject
    // sits against an edge (matches the crop clamping applied during gestures).
    const limits = computeCropPanTranslateLimits(
      {
        imageWidth, imageHeight, viewportWidth: size, viewportHeight: size, cropSize: size,
      },
      framed,
    );
    const clamp = ( v: number, lo: number, hi: number ) => Math.min( Math.max( v, lo ), hi );
    applyTransform( {
      ...framed,
      focalX: clamp( framed.focalX, limits.minTotalTranslateX, limits.maxTotalTranslateX ),
      focalY: clamp( framed.focalY, limits.minTotalTranslateY, limits.maxTotalTranslateY ),
    } );
    appliedRef.current = true;
  }, [uri, size, imageWidth, imageHeight, initialCrop, coverScale, applyTransform] );

  const layerStyle = { width: size, height: size };

  // The GestureDetector must attach to a view that is NOT transformed: gesture
  // coordinates (e.g. pinch focalX/focalY) are reported relative to the attached
  // view, so attaching to the transformed view itself creates a feedback loop
  // that makes two-finger panning lag far behind the fingers.
  return (
    <GestureDetector gesture={gestures}>
      <View style={layerStyle} onLayout={onZoomableLayout}>
        <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]}>
          <FasterImageView
            testID="ObsList.photo"
            accessibilityIgnoresInvertColors
            fadeDuration={0}
            style={[StyleSheet.absoluteFill, brightnessStyle]}
            source={{
              url: uri,
              cachePolicy: "discWithCacheControl",
              resizeMode: "contain",
            }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
};

export default ObsImageZoomable;
