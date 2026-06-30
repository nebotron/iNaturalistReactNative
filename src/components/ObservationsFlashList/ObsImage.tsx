import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import { FasterImageView, View } from "components/styledComponents";
import React, {
  useCallback, useMemo, useRef, useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import {
  computeCropStyles,
  pinchCropAtFocalPoint,
} from "sharedHelpers/normalizedCropTypes";
import { getPendingViewport, setPendingViewport } from "sharedHelpers/pendingViewport";
import useAutoBrightnessForUri from "sharedHelpers/useAutoBrightnessForUri";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";

interface Props {
  autoAdjustBrightness?: boolean;
  autoDetectSubject?: boolean;
  iconicTaxonIconSize?: number;
  iconicTaxonName?: string;
  imageClassName?: string;
  initialContainerSize?: number;
  isBackground?: boolean;
  opaque?: boolean;
  uri?: {
    uri: string;
  };
  white?: boolean;
}

const CLASS_NAMES = [
  "grow",
  "aspect-square",
] as const;

const ObsImage = ( {
  autoAdjustBrightness = false,
  autoDetectSubject = false,
  iconicTaxonName,
  imageClassName,
  initialContainerSize,
  isBackground = false,
  opaque = false,
  uri,
  white = false,
  iconicTaxonIconSize,
}: Props ) => {
  const [containerSize, setContainerSize] = useState<number | null>(
    initialContainerSize ?? null,
  );

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const detection = useSubjectDetectionForUri(
    autoDetectSubject && uri?.uri
      ? uri.uri
      : undefined,
  );

  // Live viewport from a two-finger zoom/pan gesture. Null means "show the
  // detected crop". Reset synchronously when the photo changes so recycled
  // grid cells never keep a stale viewport.
  const [viewportUri, setViewportUri] = useState( uri?.uri );
  const [viewport, setViewport] = useState<NormalizedCrop | null>( null );
  if ( viewportUri !== uri?.uri ) {
    setViewportUri( uri?.uri );
    setViewport( null );
  }

  const effectiveCrop = viewport ?? detection?.crop ?? null;

  const gestureStartCrop = useRef<NormalizedCrop | null>( null );
  const gestureStartFocal = useRef<{ x: number; y: number } | null>( null );

  // Two fingers zoom and pan the touched image; one finger falls through to the
  // list scroll. Pinch's focal point handles both zoom and pan in one gesture.
  // The start crop resumes from any prior viewport for this photo (kept in the
  // pending-viewport map) so successive pinches keep zooming from where they
  // left off, falling back to the detected crop.
  const photoUri = uri?.uri;
  const zoomPanGesture = useMemo( ( ) => Gesture.Pinch( )
    .runOnJS( true )
    .onStart( event => {
      gestureStartCrop.current = ( photoUri && getPendingViewport( photoUri ) )
        || detection?.crop
        || null;
      gestureStartFocal.current = { x: event.focalX, y: event.focalY };
    } )
    .onUpdate( event => {
      const startCrop = gestureStartCrop.current;
      const startFocal = gestureStartFocal.current;
      if ( !startCrop || !startFocal || !detection || !containerSize ) return;
      const nextCrop = pinchCropAtFocalPoint(
        startCrop,
        event.scale,
        startFocal.x,
        startFocal.y,
        event.focalX,
        event.focalY,
        containerSize,
        detection.imageWidth,
        detection.imageHeight,
      );
      setViewport( nextCrop );
      if ( photoUri ) setPendingViewport( photoUri, nextCrop );
    } ), [containerSize, detection, photoUri] );

  // crop===undefined: detection still in progress (brightness hook waits)
  // crop===null:      no subject detection requested (measure full image)
  // crop===NormalizedCrop: detection done; measure only the subject region
  const brightnessUri = autoAdjustBrightness && uri?.uri
    ? uri.uri
    : undefined;
  const brightnessCrop = autoDetectSubject
    ? detection?.crop // undefined until detection resolves
    : null; // no detection → full-image measurement

  const autoBrightness = useAutoBrightnessForUri( brightnessUri, brightnessCrop );

  const cropStyles = detection && containerSize && effectiveCrop
    ? computeCropStyles(
      effectiveCrop,
      containerSize,
      detection.imageWidth,
      detection.imageHeight,
    )
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brightnessStyle: any = autoBrightness !== 1.0
    ? { filter: [{ brightness: autoBrightness }] }
    : null;

  const content = (
    <View
      className={classNames( CLASS_NAMES, "relative overflow-hidden" )}
      onLayout={autoDetectSubject
        ? handleLayout
        : undefined}
    >
      <View className="absolute w-full h-full">
        <IconicTaxonIcon
          imageClassName={[
            ...CLASS_NAMES,
            imageClassName,
            {
              "bg-darkGray": white && isBackground,
              "bg-transparent": white && !isBackground,
            },
            "border-0",
          ]}
          iconicTaxonName={iconicTaxonName}
          white={white}
          isBackground={isBackground}
          size={iconicTaxonIconSize}
        />
      </View>
      { uri?.uri && !cropStyles && (
        <FasterImageView
          className={classNames( CLASS_NAMES )}
          style={brightnessStyle}
          testID="ObsList.photo"
          accessibilityIgnoresInvertColors
          fadeDuration={0}
          source={{
            url: uri.uri,
            cachePolicy: "discWithCacheControl",
            resizeMode: "cover",
          }}
        />
      ) }
      { uri?.uri && cropStyles && (
        <View style={[cropStyles.wrapperStyle, brightnessStyle]}>
          <FasterImageView
            testID="ObsList.photo"
            accessibilityIgnoresInvertColors
            fadeDuration={0}
            style={cropStyles.imageStyle}
            source={{
              url: uri.uri,
              cachePolicy: "discWithCacheControl",
              resizeMode: "stretch",
            }}
          />
        </View>
      ) }
      { opaque && (
        <View className="absolute w-full h-full bg-white opacity-50" />
      ) }
    </View>
  );

  if ( !autoDetectSubject ) {
    return content;
  }

  return (
    <GestureDetector gesture={zoomPanGesture}>
      {content}
    </GestureDetector>
  );
};

export default ObsImage;
