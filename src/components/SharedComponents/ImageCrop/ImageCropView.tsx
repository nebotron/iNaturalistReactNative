import CustomImageZoom from "components/MediaViewer/CustomImageZoom";
import type { SharedZoomableImageRef } from "components/MediaViewer/SharedZoomableImage";
import { INatIconButton } from "components/SharedComponents";
import { Text, View } from "components/styledComponents";
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
import { normalizedCropToImageZoomTransform } from "sharedHelpers/normalizedCropToImageZoomTransform";
import { imageZoomTransformToNormalizedCrop } from "sharedHelpers/imageZoomTransformToCrop";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { computeContainRect, square2048Crop } from "sharedHelpers/normalizedCropTypes";
import colors from "styles/tailwindColors";

const DIM_COLOR = "rgba(0, 0, 0, 0.55)";
const TOOLBAR_HEIGHT = 104;
const CROP_BUTTON_SIZE = 88;
const CROP_ICON_SIZE = 36;
const UPLOAD_MAX_SIDE = 2048;

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
  framePadding: number;
  initialCrop?: NormalizedCrop | null;
  labels: ImageCropLabels;
  onConfirm: ( crop: NormalizedCrop ) => void | Promise<void>;
  onCropChange?: ( crop: NormalizedCrop ) => void;
  onDelete?: () => void;
}

const ImageCropView = ( {
  sourceUri,
  imageWidth,
  imageHeight,
  framePadding,
  initialCrop,
  labels,
  onConfirm,
  onCropChange,
  onDelete,
}: Props ) => {
  const insets = useSafeAreaInsets( );
  const { width: windowWidth } = useWindowDimensions( );
  const zoomRef = useRef<SharedZoomableImageRef>( null );
  const appliedInitialCropKey = useRef<string | null>( null );
  const [cropAreaHeight, setCropAreaHeight] = useState( 0 );
  const [saving, setSaving] = useState( false );
  const [willBeDownsized, setWillBeDownsized] = useState( false );

  const boxSize = useMemo( ( ) => {
    const maxSide = Math.min( windowWidth, cropAreaHeight );
    if ( maxSide <= 0 ) {
      return 0;
    }
    return maxSide * ( 1 - 2 * framePadding );
  }, [cropAreaHeight, framePadding, windowWidth] );

  const boxLeft = ( windowWidth - boxSize ) / 2;
  const boxTop = ( cropAreaHeight - boxSize ) / 2;

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
    setWillBeDownsized(
      Math.max( crop.w * imageWidth, crop.h * imageHeight ) > UPLOAD_MAX_SIDE,
    );
    onCropChange?.( crop );
  }, [boxSize, cropAreaHeight, imageHeight, imageWidth, onCropChange, windowWidth] );

  const handleScaleChange = useCallback( ( scale: number ) => {
    if ( boxSize <= 0 || cropAreaHeight <= 0 || scale <= 0 ) {
      return;
    }
    const contain = computeContainRect( windowWidth, cropAreaHeight, imageWidth, imageHeight );
    if ( contain.width <= 0 || contain.height <= 0 ) {
      return;
    }
    setWillBeDownsized(
      Math.max(
        boxSize * imageWidth / ( scale * contain.width ),
        boxSize * imageHeight / ( scale * contain.height ),
      ) > UPLOAD_MAX_SIDE,
    );
  }, [boxSize, cropAreaHeight, imageHeight, imageWidth, windowWidth] );

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
    setWillBeDownsized(
      Math.max( initialCrop.w * imageWidth, initialCrop.h * imageHeight ) > UPLOAD_MAX_SIDE,
    );
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
    const crop = square2048Crop( imageWidth, imageHeight );
    const transform = normalizedCropToImageZoomTransform(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      crop,
    );
    zoomRef.current.applyTransform( transform );
    updateDownsizeStatus( );
  }, [
    boxSize,
    cropAreaHeight,
    imageHeight,
    imageWidth,
    windowWidth,
    updateDownsizeStatus,
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

  const instructionStyle = useMemo(
    ( ) => ( { paddingTop: insets.top + 8 } ),
    [insets.top],
  );

  const toolbarStyle = useMemo(
    ( ) => ( {
      minHeight: TOOLBAR_HEIGHT + insets.bottom,
      paddingBottom: insets.bottom,
    } ),
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
      <Text
        className="px-4 py-2 text-center text-white"
        style={instructionStyle}
      >
        {labels.instructions}
      </Text>

      <View
        className="flex-1"
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

      <View
        className="flex-row items-center justify-center gap-4 bg-[#1c1c1c] px-10"
        style={[styles.toolbar, toolbarStyle]}
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
  );
};

export default ImageCropView;
