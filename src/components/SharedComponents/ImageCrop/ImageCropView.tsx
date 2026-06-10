import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import {
  ActivityIndicator,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { INatIconButton } from "components/SharedComponents";
import { Text, View } from "components/styledComponents";
import type {
  ImageZoomTransform,
  NormalizedCrop,
} from "sharedHelpers/cropMath";
import {
  cropToImageZoomTransform,
  imageZoomTransformToCrop,
} from "sharedHelpers/cropMath";
import colors from "styles/tailwindColors";

const MIN_SCALE = 1;
const MAX_SCALE = 50;
const DIM_COLOR = "rgba(0, 0, 0, 0.55)";
const TOOLBAR_HEIGHT = 104;
const CROP_BUTTON_SIZE = 88;
const CROP_ICON_SIZE = 36;

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
  image: {
    flex: 1,
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
  initialCrop: NormalizedCrop;
  labels: ImageCropLabels;
  onConfirm: ( crop: NormalizedCrop ) => void | Promise<void>;
  onDelete?: ( ) => void;
}

const ImageCropView = ( {
  sourceUri,
  imageWidth,
  imageHeight,
  framePadding,
  initialCrop,
  labels,
  onConfirm,
  onDelete,
}: Props ) => {
  const insets = useSafeAreaInsets( );
  const { width: windowWidth } = useWindowDimensions( );
  const [cropAreaHeight, setCropAreaHeight] = useState( 0 );
  const [saving, setSaving] = useState( false );

  // Animated transform shared values (pan + pinch)
  const scale = useSharedValue( 1 );
  const translateX = useSharedValue( 0 );
  const translateY = useSharedValue( 0 );
  const focalX = useSharedValue( 0 );
  const focalY = useSharedValue( 0 );

  // Gesture start snapshots
  const savedScale = useSharedValue( 1 );
  const savedTranslateX = useSharedValue( 0 );
  const savedTranslateY = useSharedValue( 0 );
  const savedFocalX = useSharedValue( 0 );
  const savedFocalY = useSharedValue( 0 );
  const pinchOriginX = useSharedValue( 0 );
  const pinchOriginY = useSharedValue( 0 );

  // Viewport center as shared values so gesture worklets can read them
  const viewportCenterX = useSharedValue( windowWidth / 2 );
  const viewportCenterY = useSharedValue( 0 );

  useEffect( ( ) => {
    viewportCenterX.value = windowWidth / 2;
  }, [viewportCenterX, windowWidth] );

  const boxSize = useMemo( ( ) => {
    const maxSide = Math.min( windowWidth, cropAreaHeight );
    if ( maxSide <= 0 ) return 0;
    return maxSide * ( 1 - 2 * framePadding );
  }, [cropAreaHeight, framePadding, windowWidth] );

  const boxLeft = ( windowWidth - boxSize ) / 2;
  const boxTop = ( cropAreaHeight - boxSize ) / 2;

  // Track which (sourceUri, crop, boxSize) has been applied to avoid resetting
  // the user's position on unrelated re-renders.
  const appliedCropKey = useRef<string | null>( null );

  useEffect( ( ) => {
    if ( boxSize <= 0 || cropAreaHeight <= 0 ) return;

    const key = `${sourceUri}:${initialCrop.x}:${initialCrop.y}`
      + `:${initialCrop.w}:${initialCrop.h}:${boxSize}`;
    if ( appliedCropKey.current === key ) return;
    appliedCropKey.current = key;

    const transform = cropToImageZoomTransform(
      imageWidth,
      imageHeight,
      windowWidth,
      cropAreaHeight,
      boxSize,
      initialCrop,
    );

    scale.value = transform.scale;
    savedScale.value = transform.scale;
    translateX.value = transform.translateX;
    translateY.value = transform.translateY;
    savedTranslateX.value = transform.translateX;
    savedTranslateY.value = transform.translateY;
    focalX.value = transform.focalX;
    focalY.value = transform.focalY;
    savedFocalX.value = transform.focalX;
    savedFocalY.value = transform.focalY;
  }, [
    boxSize,
    cropAreaHeight,
    focalX,
    focalY,
    imageHeight,
    imageWidth,
    initialCrop,
    savedFocalX,
    savedFocalY,
    savedScale,
    savedTranslateX,
    savedTranslateY,
    scale,
    sourceUri,
    translateX,
    translateY,
    windowWidth,
  ] );

  const pinchGesture = Gesture.Pinch( )
    .onStart( event => {
      savedScale.value = scale.value;
      savedFocalX.value = focalX.value;
      savedFocalY.value = focalY.value;
      pinchOriginX.value = event.focalX;
      pinchOriginY.value = event.focalY;
    } )
    .onUpdate( event => {
      const newScale = Math.min(
        MAX_SCALE,
        Math.max( MIN_SCALE, savedScale.value * event.scale ),
      );
      scale.value = newScale;
      focalX.value = savedFocalX.value
        + ( viewportCenterX.value - pinchOriginX.value )
        * ( newScale - savedScale.value );
      focalY.value = savedFocalY.value
        + ( viewportCenterY.value - pinchOriginY.value )
        * ( newScale - savedScale.value );
    } );

  const panGesture = Gesture.Pan( )
    .averageTouches( true )
    .onStart( ( ) => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    } )
    .onUpdate( event => {
      translateX.value = savedTranslateX.value + event.translationX;
      translateY.value = savedTranslateY.value + event.translationY;
    } );

  const gestures = Gesture.Simultaneous( pinchGesture, panGesture );

  const animatedStyle = useAnimatedStyle( ( ) => ( {
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { translateX: focalX.value },
      { translateY: focalY.value },
      { scale: scale.value },
    ],
  } ) );

  const handleCropAreaLayout = useCallback( ( event: LayoutChangeEvent ) => {
    const h = event.nativeEvent.layout.height;
    setCropAreaHeight( h );
    viewportCenterY.value = h / 2;
  }, [viewportCenterY] );

  const handleConfirm = useCallback( async ( ) => {
    if ( saving || boxSize <= 0 || cropAreaHeight <= 0 ) return;
    setSaving( true );
    try {
      const transform: ImageZoomTransform = {
        scale: scale.value,
        translateX: translateX.value,
        translateY: translateY.value,
        focalX: focalX.value,
        focalY: focalY.value,
      };
      const crop = imageZoomTransformToCrop(
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
    focalX,
    focalY,
    imageHeight,
    imageWidth,
    onConfirm,
    saving,
    scale,
    translateX,
    translateY,
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
    height: boxTop,
    left: 0,
    top: 0,
    width: windowWidth,
  } ), [boxTop, windowWidth] );

  const dimBottomStyle = useMemo( ( ): ViewStyle => ( {
    height: Math.max( 0, cropAreaHeight - boxTop - boxSize ),
    left: 0,
    top: boxTop + boxSize,
    width: windowWidth,
  } ), [boxSize, boxTop, cropAreaHeight, windowWidth] );

  const dimLeftStyle = useMemo( ( ): ViewStyle => ( {
    height: boxSize,
    left: 0,
    top: boxTop,
    width: boxLeft,
  } ), [boxLeft, boxSize, boxTop] );

  const dimRightStyle = useMemo( ( ): ViewStyle => ( {
    height: boxSize,
    left: boxLeft + boxSize,
    top: boxTop,
    width: Math.max( 0, windowWidth - boxLeft - boxSize ),
  } ), [boxLeft, boxSize, boxTop, windowWidth] );

  const frameStyle = useMemo( ( ): ViewStyle => ( {
    height: boxSize,
    left: boxLeft,
    top: boxTop,
    width: boxSize,
  } ), [boxLeft, boxSize, boxTop] );

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
        onLayout={handleCropAreaLayout}
      >
        {cropAreaHeight > 0 && (
          <GestureDetector gesture={gestures}>
            <View style={styles.zoomLayer}>
              <Animated.Image
                testID={`ImageCropView.${sourceUri}`}
                style={[styles.image, animatedStyle]}
                source={{ uri: sourceUri }}
                resizeMode="contain"
              />
            </View>
          </GestureDetector>
        )}

        {boxSize > 0 && (
          <>
            <View pointerEvents="none" style={[styles.dim, dimTopStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimBottomStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimLeftStyle]} />
            <View pointerEvents="none" style={[styles.dim, dimRightStyle]} />
            <View pointerEvents="none" style={[styles.frame, frameStyle]} />
          </>
        )}
      </View>

      <View
        className="flex-row items-center justify-between bg-[#1c1c1c] px-10"
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
