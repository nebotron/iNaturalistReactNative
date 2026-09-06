import CustomImageZoom from "components/MediaViewer/CustomImageZoom";
import { ZoomBrightnessSliders } from "components/MediaViewer/IdentifyPhoto";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import { INatIconButton } from "components/SharedComponents";
import { View } from "components/styledComponents";
import { useStackHost } from "navigation/StackHostContext";
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
  Image,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import {
  normalizedCropToImageZoomTransform,
} from "sharedHelpers/normalizedCropToImageZoomTransform";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect, square2048Crop } from "sharedHelpers/normalizedCropTypes";
import {
  EXPOSURE_STOPS_MAX,
  EXPOSURE_STOPS_MIN,
} from "sharedHooks/useIdentifyPhotoBrightness";
import useIdentifyPhotoControls from "sharedHooks/useIdentifyPhotoControls";
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
// How long to wait before showing the loading spinner. With the next photo
// preloaded and decoded ahead of time (see warmUris), advancing a bulk crop
// waits a frame or two for the new image to paint -- just long enough to flash
// a spinner on and off, which reads as jank rather than as loading. Only a load
// that really is slow gets one.
const SPINNER_DELAY_MS = 150;
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
  hidden: {
    opacity: 0,
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
  // Local file URIs of the photos coming up next in a bulk crop. They are
  // mounted invisibly at exactly the size and resize mode the real image uses,
  // so React Native reads and decodes them into its image cache while the user
  // is still cropping the current photo. Having the file on disk (what the
  // preload cache holds) isn't enough on its own: decoding a full-size photo is
  // what the spinner between photos is waiting on, and that only happens once
  // an <Image> asks for it. Matching the frame size matters -- the cache is
  // keyed by url + size + scale + resize mode, so a warm-up at a different size
  // would be decoded all over again.
  warmUris?: string[];
  // How long this photo's file took to decode and paint, reported once it has.
  // Part of what a bulk crop waits on between photos, and the only part that
  // happens after the editor already has everything it needs.
  onDecoded?: ( ms: number ) => void;
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
  warmUris,
  onDecoded,
  onConfirm,
  onCropChange,
  onDelete,
}: Props ) => {
  const { t } = useTranslation( );
  const insets = useSafeAreaInsets( );
  const { hasBottomTabBar } = useStackHost( );
  const { width: windowWidth } = useWindowDimensions( );
  const zoomRef = useRef<SharedZoomableImageRef>( null );
  const appliedInitialCropKey = useRef<string | null>( null );
  const [cropAreaHeight, setCropAreaHeight] = useState( 0 );
  const [saving, setSaving] = useState( false );
  const [willBeDownsized, setWillBeDownsized] = useState( false );

  // The underlying <Image> keeps painting the previous photo's pixels until the
  // new file decodes, while the new photo's crop transform is applied right
  // away -- so advancing a bulk crop would otherwise show the old photo framed
  // in the wrong position. Track which uri has actually loaded and keep the
  // zoom layer invisible (but mounted, so layout and the transform still apply)
  // until then, showing a spinner instead. onError counts as loaded so a photo
  // that can't be decoded doesn't spin forever.
  const [loadedUri, setLoadedUri] = useState<string | null>( null );
  const imageReady = loadedUri === sourceUri;
  // When this photo became the one to draw, so the decode it then waits on can
  // be reported separately from the load that preceded it.
  const shownAt = useRef( { uri: "", at: 0 } );
  if ( shownAt.current.uri !== sourceUri ) {
    shownAt.current = { uri: sourceUri, at: Date.now( ) };
  }
  const handleImageLoad = useCallback( ( ) => {
    setLoadedUri( sourceUri );
    onDecoded?.( Date.now( ) - shownAt.current.at );
  }, [onDecoded, sourceUri] );

  // Which photo has been loading long enough to deserve a spinner. Recorded per
  // uri rather than as a flag so advancing to the next photo starts the delay
  // over without an effect having to clear it.
  const [slowUri, setSlowUri] = useState<string | null>( null );
  useEffect( ( ) => {
    if ( imageReady ) {
      return ( ) => {};
    }
    const timer = setTimeout( ( ) => setSlowUri( sourceUri ), SPINNER_DELAY_MS );
    return ( ) => clearTimeout( timer );
  }, [imageReady, sourceUri] );
  const spinnerShown = !imageReady && slowUri === sourceUri;

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
      ( boxSize * imageWidth ) / ( scale * contain.width ),
      ( boxSize * imageHeight ) / ( scale * contain.height ),
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

  // Recompute the downsize warning on every scale change, whatever its source
  // (slider, pinch, double-tap, initial framing).
  const updateDownsizeWarning = useCallback( ( scale: number ) => {
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

  // Zoom slider plus preview-only exposure. Brightness drives the CSS filter
  // live and, on release, records the label to the brightness log; it never
  // feeds into the cropped file (onConfirm reads the untouched source). Zoom
  // never resets on a new photo here — the initialCrop effect below frames each
  // one, and snapping the slider to MIN_ZOOM first would show the wrong value.
  const {
    brightness,
    brightnessStops,
    handleBrightnessChange,
    handleBrightnessComplete,
    handleScaleChange: syncZoomSlider,
    handleZoomChange,
    zoomScale,
  } = useIdentifyPhotoControls( {
    brightnessKey: brightnessLogKey ?? undefined,
    applyZoom,
    onScaleChange: updateDownsizeWarning,
    skipZoomReset: true,
  } );

  useEffect( ( ) => {
    if (
      !initialCrop
      || boxSize <= 0
      || cropAreaHeight <= 0
      || !zoomRef.current
    ) {
      return;
    }

    const cropKey = `${sourceUri}:${initialCrop.x}:${initialCrop.y}:${initialCrop.w}`
      + `:${initialCrop.h}:${boxSize}`;
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
  // pushed under the safe area -- unless the bottom tab bar is below it, which
  // clears the safe area itself.
  const bottomPanelStyle = useMemo(
    ( ) => ( {
      paddingBottom: hasBottomTabBar
        ? 0
        : insets.bottom,
    } ),
    [hasBottomTabBar, insets.bottom],
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

  const cropPanContext = useMemo( ( ) => (
    boxSize <= 0 || cropAreaHeight <= 0
      ? undefined
      : {
        imageWidth,
        imageHeight,
        viewportWidth: windowWidth,
        viewportHeight: cropAreaHeight,
        cropSize: boxSize,
      }
  ), [boxSize, cropAreaHeight, imageHeight, imageWidth, windowWidth] );

  return (
    <View className="flex-1 bg-black">
      <View
        className="flex-1 overflow-hidden"
        onLayout={event => {
          setCropAreaHeight( event.nativeEvent.layout.height );
        }}
      >
        {/* Rendered under everything else, invisible and untouchable: these
            exist only to make React Native decode the next photos. */}
        {cropAreaHeight > 0 && warmUris?.map( warmUri => (
          <Image
            key={warmUri}
            accessible={false}
            accessibilityIgnoresInvertColors
            fadeDuration={0}
            pointerEvents="none"
            resizeMode="contain"
            source={{ uri: warmUri }}
            style={[styles.zoomLayer, styles.hidden]}
          />
        ) )}

        {cropAreaHeight > 0 && (
          <View style={[styles.zoomLayer, !imageReady && styles.hidden]}>
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
              onLoad={handleImageLoad}
              onError={handleImageLoad}
              onScaleChange={syncZoomSlider}
            />
          </View>
        )}

        {spinnerShown && (
          <View style={styles.zoomLayer} className="items-center justify-center">
            <ActivityIndicator color={colors.white} />
          </View>
        )}

        {imageReady && boxSize > 0 && (
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
          fineSliders
          brightnessStops={brightnessStops}
          exposureStopsMin={EXPOSURE_STOPS_MIN}
          exposureStopsMax={EXPOSURE_STOPS_MAX}
          onZoomChange={handleZoomChange}
          onZoomComplete={updateDownsizeStatus}
          onBrightnessChange={handleBrightnessChange}
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
