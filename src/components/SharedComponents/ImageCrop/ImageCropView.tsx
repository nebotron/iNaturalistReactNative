import CustomImageZoom from "components/MediaViewer/CustomImageZoom";
import {
  clampZoom,
  MIN_ZOOM,
  ZoomBrightnessSliders,
  zoomPosToScale,
} from "components/MediaViewer/IdentifyPhoto";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import { INatIconButton } from "components/SharedComponents";
import { View } from "components/styledComponents";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ViewStyle } from "react-native";
import {
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getBrightness, saveBrightness } from "sharedHelpers/brightnessLog";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import { normalizedCropToImageZoomTransform } from "sharedHelpers/normalizedCropToImageZoomTransform";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect, square2048Crop } from "sharedHelpers/normalizedCropTypes";
import {
  EXPOSURE_STOPS_DEFAULT,
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
  gainToStops,
  stopsToGain,
} from "sharedHooks/useIdentifyPhotoBrightness";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

const DIM_COLOR = "rgba(0, 0, 0, 0.55)";
const TOOLBAR_HEIGHT = 104;
const CROP_BUTTON_SIZE = 88;
const CROP_ICON_SIZE = 36;
const UPLOAD_MAX_SIDE = 2048;
// Two-finger panning is implemented as a pinch with a scale ratio that stays
// near 1, so ordinary hand tremor makes the live scale (and thus the cropped
// side length) drift by a few pixels even when the user isn't deliberately
// zooming. Right at the 2048 threshold that drift flips the warning border on
// and off. Use hysteresis instead of a single-sample comparison so crossing
// the threshold briefly during a gesture doesn't flicker the indicator.
const DOWNSIZE_HYSTERESIS_PX = 8;
const isDownsized = ( sizePx: number, wasDownsized: boolean ) => ( wasDownsized
  ? sizePx > UPLOAD_MAX_SIDE - DOWNSIZE_HYSTERESIS_PX
  : sizePx > UPLOAD_MAX_SIDE + DOWNSIZE_HYSTERESIS_PX );

const styles = StyleSheet.create( {
  confirmSlot: {
    alignItems: "center",
    height: CROP_BUTTON_SIZE,
    justifyContent: "center",
    width: CROP_BUTTON_SIZE,
  },
  dim: {
    backgroundColor: DIM_COLOR,
    position: "absolute",
  },
  frame: {
    borderColor: colors.white,
    borderWidth: 1,
    position: "absolute",
  },
  toolbar: {
    minHeight: TOOLBAR_HEIGHT,
  },
  zoomLayer: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
} );

export interface ImageCropLabels {
  confirm: string;
  delete?: string;
  instructions: string;
}

interface Props {
  sourceUri: string;
  imageWidth: number;
  imageHeight: number;
  initialCrop?: NormalizedCrop | null;
  labels: ImageCropLabels;
  // Key under which the exposure slider reads/writes the brightness log. The
  // slider is preview-only -- it never alters the cropped output -- so this is
  // just what the saved brightness label is keyed to.
  brightnessLogKey?: string | null;
  onConfirm: ( crop: NormalizedCrop ) => void | Promise<void>;
  onCropChange?: ( crop: NormalizedCrop ) => void;
  onDelete?: () => void;
}

const ImageCropView = ( {
  sourceUri,
  imageWidth,
  imageHeight,
  initialCrop,
  labels,
  brightnessLogKey,
  onConfirm,
  onCropChange,
  onDelete,
}: Props ) => {
  const { t } = useTranslation( );
  const insets = useSafeAreaInsets( );
  const { width: windowWidth } = useWindowDimensions( );
  const zoomRef = useRef<SharedZoomableImageRef>( null );
  const appliedInitialCropKey = useRef<string | null>( null );
  const [cropAreaHeight, setCropAreaHeight] = useState( 0 );
  const [saving, setSaving] = useState( false );
  const [willBeDownsized, setWillBeDownsized] = useState( false );
  const [zoomScale, setZoomScale] = useState( MIN_ZOOM );
  const [brightnessStops, setBrightnessStops] = useState( EXPOSURE_STOPS_DEFAULT );
  const brightness = stopsToGain( brightnessStops );

  // Load any previously-saved brightness for this photo so the label
  // round-trips; otherwise reset to neutral for a new photo.
  useEffect( ( ) => {
    const saved = brightnessLogKey
      ? getBrightness( brightnessLogKey )
      : null;
    setBrightnessStops( saved !== null
      ? gainToStops( saved )
      : EXPOSURE_STOPS_DEFAULT );
  }, [brightnessLogKey] );

  const boxSize = useMemo( ( ) => {
    // Full screen width, capped by the available crop area height.
    const maxSide = Math.min( windowWidth, cropAreaHeight );
    if ( maxSide <= 0 ) {
      return 0;
    }
    return maxSide;
  }, [cropAreaHeight, windowWidth] );

  const boxLeft = ( windowWidth - boxSize ) / 2;
  const boxTop = ( cropAreaHeight - boxSize ) / 2;

  // The cropped side length in image pixels is purely a function of zoom
  // scale -- the box is centered and square in screen space, so panning
  // (translation) can never change it. Deriving it from scale alone, rather
  // than from the crop's x/y/w/h (which round-trips through the pan position),
  // guarantees panning can't perturb the downsize check.
  const cropSidePxFromScale = useCallback( ( scale: number ) => {
    if ( boxSize <= 0 || cropAreaHeight <= 0 || scale <= 0 ) {
      return 0;
    }
    const contain = computeContainRect( windowWidth, cropAreaHeight, imageWidth, imageHeight );
    if ( contain.width <= 0 || contain.height <= 0 ) {
      return 0;
    }
    return Math.max(
      boxSize * imageWidth / ( scale * contain.width ),
      boxSize * imageHeight / ( scale * contain.height ),
    );
  }, [boxSize, cropAreaHeight, imageHeight, imageWidth, windowWidth] );

  const updateDownsizeStatus = useCallback( ( ) => {
    if ( !zoomRef.current || boxSize <= 0 || cropAreaHeight <= 0 ) {
      return;
    }
    const transform = zoomRef.current.readTransform( );
    const crop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      transform,
    );
    const sizePx = cropSidePxFromScale( transform.scale );
    setWillBeDownsized( prev => isDownsized( sizePx, prev ) );
    onCropChange?.( crop );
  }, [
    boxSize,
    cropAreaHeight,
    cropSidePxFromScale,
    imageHeight,
    imageWidth,
    onCropChange,
    windowWidth,
  ] );

  const handleScaleChange = useCallback( ( scale: number ) => {
    // Keep the zoom slider in sync with pinch / double-tap / initial framing.
    setZoomScale( clampZoom( scale ) );
    const sizePx = cropSidePxFromScale( scale );
    if ( sizePx <= 0 ) {
      return;
    }
    setWillBeDownsized( prev => isDownsized( sizePx, prev ) );
  }, [cropSidePxFromScale] );

  // Rescale the image while keeping whatever sits at the crop-box centre (the
  // viewport centre) fixed there, rather than snapping back to the image
  // centre. Mirrors the identify screen's slider zoom.
  const applyZoom = useCallback( ( scale: number ) => {
    const img = zoomRef.current;
    if ( !img || windowWidth <= 0 || cropAreaHeight <= 0 ) {
      return;
    }
    const centreX = windowWidth / 2;
    const centreY = cropAreaHeight / 2;
    const current = img.readTransform( );
    if ( current.scale <= 0 ) {
      img.applyTransform( {
        scale, translateX: 0, translateY: 0, focalX: 0, focalY: 0,
      } );
      return;
    }
    const totalTx = current.translateX + current.focalX;
    const totalTy = current.translateY + current.focalY;
    const localX = centreX - totalTx / current.scale;
    const localY = centreY - totalTy / current.scale;
    img.applyTransform( {
      scale,
      translateX: 0,
      translateY: 0,
      focalX: ( centreX - localX ) * scale,
      focalY: ( centreY - localY ) * scale,
    } );
  }, [cropAreaHeight, windowWidth] );

  const handleZoomChange = useCallback( ( pos: number ) => {
    const scale = zoomPosToScale( pos );
    setZoomScale( scale );
    applyZoom( scale );
  }, [applyZoom] );

  // Preview-only exposure: drives the CSS brightness filter live and, on
  // release, records the label to the brightness log. It never feeds into the
  // cropped file (onConfirm reads the untouched source).
  const handleBrightnessComplete = useCallback( ( value: number ) => {
    setBrightnessStops( value );
    if ( brightnessLogKey ) {
      saveBrightness( brightnessLogKey, stopsToGain( value ) );
    }
  }, [brightnessLogKey] );

  useEffect( ( ) => {
    if (
      !initialCrop
      || boxSize <= 0
      || cropAreaHeight <= 0
      || !zoomRef.current
    ) {
      return;
    }

    const cropKey = `${sourceUri}:${initialCrop.x}:${initialCrop.y}:${initialCrop.w}:${initialCrop.h}:${boxSize}`;
    if ( appliedInitialCropKey.current === cropKey ) {
      return;
    }

    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      initialCrop,
    );
    zoomRef.current.applyTransform( transform );
    appliedInitialCropKey.current = cropKey;
    // Read directly from crop; applyTransform (a worklet) may not have propagated to JS yet.
    const initialSizePx = Math.max( initialCrop.w * imageWidth, initialCrop.h * imageHeight );
    setWillBeDownsized( prev => isDownsized( initialSizePx, prev ) );
  }, [
    boxSize,
    cropAreaHeight,
    imageHeight,
    imageWidth,
    initialCrop,
    sourceUri,
    windowWidth,
  ] );

  // When there is no initialCrop the image auto-resets to scale=1. Compute the
  // downsize status for that default view once the layout is ready.
  useEffect( ( ) => {
    if ( initialCrop || boxSize <= 0 || cropAreaHeight <= 0 ) {
      return;
    }
    updateDownsizeStatus( );
  }, [boxSize, cropAreaHeight, initialCrop, updateDownsizeStatus] );

  const handleSet2048 = useCallback( ( ) => {
    if ( !zoomRef.current || boxSize <= 0 || cropAreaHeight <= 0 ) {
      return;
    }
    const currentCrop = imageZoomTransformToNormalizedCrop(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      zoomRef.current.readTransform( ),
    );
    const crop = square2048Crop( imageWidth, imageHeight, currentCrop );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      crop,
    );
    zoomRef.current.applyTransform( transform );
    // square2048Crop never exceeds UPLOAD_MAX_SIDE by construction, so clear
    // the warning directly instead of reading the transform back -- that read
    // can run before the just-applied worklet update reaches JS, and would
    // otherwise fall inside the hysteresis band and stay stuck on if the crop
    // was already oversized before this snap (the button's main use case).
    setWillBeDownsized( false );
    onCropChange?.( crop );
  }, [
    boxSize,
    cropAreaHeight,
    imageHeight,
    imageWidth,
    onCropChange,
    windowWidth,
  ] );

  const handleConfirm = useCallback( async ( ) => {
    if ( saving || !zoomRef.current || boxSize <= 0 || cropAreaHeight <= 0 ) {
      return;
    }
    setSaving( true );
    try {
      const transform = zoomRef.current.readTransform( );
      const crop = imageZoomTransformToNormalizedCrop(
        imageWidth,
        imageHeight,
        windowWidth,
        cropAreaHeight,
        boxSize,
        transform,
      );
      await onConfirm( crop );
    } finally {
      setSaving( false );
    }
  }, [
    boxSize,
    cropAreaHeight,
    imageHeight,
    imageWidth,
    onConfirm,
    saving,
    windowWidth,
  ] );

  // Padding for the shared bottom control panel (sliders + buttons). The panel
  // clears the home indicator itself so the sliders and buttons are never
  // pushed under the safe area.
  const bottomPanelStyle = useMemo(
    ( ) => ( { paddingBottom: insets.bottom } ),
    [insets.bottom],
  );

  const dimTopStyle = useMemo( ( ): ViewStyle => ( {
    top: 0,
    left: 0,
    width: windowWidth,
    height: boxTop,
  } ), [boxTop, windowWidth] );

  const dimBottomStyle = useMemo( ( ): ViewStyle => ( {
    top: boxTop + boxSize,
    left: 0,
    width: windowWidth,
    height: Math.max( 0, cropAreaHeight - boxTop - boxSize ),
  } ), [boxSize, boxTop, cropAreaHeight, windowWidth] );

  const dimLeftStyle = useMemo( ( ): ViewStyle => ( {
    top: boxTop,
    left: 0,
    width: boxLeft,
    height: boxSize,
  } ), [boxLeft, boxSize, boxTop] );

  const dimRightStyle = useMemo( ( ): ViewStyle => ( {
    top: boxTop,
    left: boxLeft + boxSize,
    width: Math.max( 0, windowWidth - boxLeft - boxSize ),
    height: boxSize,
  } ), [boxLeft, boxSize, boxTop, windowWidth] );

  const frameStyle = useMemo( ( ): ViewStyle => ( {
    left: boxLeft,
    top: boxTop,
    width: boxSize,
    height: boxSize,
  } ), [boxLeft, boxSize, boxTop] );

  const cropPanContext = useMemo( ( ) => {
    if ( boxSize <= 0 || cropAreaHeight <= 0 ) {
      return undefined;
    }

    return {
      imageWidth,
      imageHeight,
      viewportWidth: windowWidth,
      viewportHeight: cropAreaHeight,
      cropSize: boxSize,
    };
  }, [boxSize, cropAreaHeight, imageHeight, imageWidth, windowWidth] );

  return (
    <View className="flex-1 bg-black">
      <View
        className="flex-1 overflow-hidden"
        onLayout={event => {
          setCropAreaHeight( event.nativeEvent.layout.height );
        }}
      >
        {cropAreaHeight > 0 && (
          <View style={styles.zoomLayer}>
            <CustomImageZoom
              uri={sourceUri}
              resetKey={sourceUri}
              width={windowWidth}
              height={cropAreaHeight}
              zoomRef={zoomRef}
              autoReset={!initialCrop}
              cropPanContext={cropPanContext}
              brightness={brightness}
              testID={`ImageCropView.${sourceUri}`}
              onInteractionEnd={updateDownsizeStatus}
              onScaleChange={handleScaleChange}
            />
          </View>
        )}

        {boxSize > 0 && (
          <>
            <View pointerEvents="none" style={[styles.dim, dimTopStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimBottomStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimLeftStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimRightStyle]} />
            <View
              pointerEvents="none"
              style={[
                styles.frame,
                frameStyle,
                willBeDownsized && { borderColor: colors.warningYellow },
              ]}
            />
          </>
        )}
      </View>

      {/* Single bottom control panel: the zoom + brightness sliders sit
          directly above the button row inside one opaque container, so the
          buttons can never overlap or hide the (lower) brightness slider. */}
      <View className="bg-[#1c1c1c] pt-1" style={bottomPanelStyle}>
        <ZoomBrightnessSliders
          zoomScale={zoomScale}
          brightnessStops={brightnessStops}
          exposureStopsMin={EXPOSURE_STOPS_MIN}
          exposureStopsMax={EXPOSURE_STOPS_MAX}
          onZoomChange={handleZoomChange}
          onZoomComplete={updateDownsizeStatus}
          onBrightnessChange={setBrightnessStops}
          onBrightnessComplete={handleBrightnessComplete}
          zoomAccessibilityLabel={t( "Adjust-zoom" )}
          brightnessAccessibilityLabel={t( "Adjust-brightness" )}
          iconColor={colors.white}
        />

        <View
          className="flex-row items-center justify-center gap-4 px-10"
          style={styles.toolbar}
        >
          {onDelete && labels.delete
            ? (
              <INatIconButton
                icon="trash-outline"
                accessibilityLabel={labels.delete}
                color={colors.warningRed}
                height={CROP_BUTTON_SIZE}
                width={CROP_BUTTON_SIZE}
                size={CROP_ICON_SIZE}
                onPress={onDelete}
                disabled={saving}
              />
            )
            : <View style={styles.confirmSlot} />}
          <INatIconButton
            icon="crop"
            accessibilityLabel="2048×2048"
            color={colors.inatGreen}
            height={CROP_BUTTON_SIZE}
            width={CROP_BUTTON_SIZE}
            size={CROP_ICON_SIZE}
            onPress={handleSet2048}
            disabled={saving}
          />
          {saving
            ? (
              <View style={styles.confirmSlot}>
                <ActivityIndicator color={colors.inatGreen} />
              </View>
            )
            : (
              <INatIconButton
                icon="checkmark"
                accessibilityLabel={labels.confirm}
                color={colors.inatGreen}
                height={CROP_BUTTON_SIZE}
                width={CROP_BUTTON_SIZE}
                size={CROP_ICON_SIZE}
                onPress={handleConfirm}
              />
            )}
        </View>
      </View>
    </View>
  );
};

export default ImageCropView;
