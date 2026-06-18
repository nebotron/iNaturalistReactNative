import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import { FasterImageView, View } from "components/styledComponents";
import React, { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { computeCropStyles } from "sharedHelpers/normalizedCropTypes";
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

  // crop===undefined: detection still in progress (brightness hook waits)
  // crop===null:      no subject detection requested (measure full image)
  // crop===NormalizedCrop: detection done; measure only the subject region
  const brightnessUri = autoAdjustBrightness && uri?.uri ? uri.uri : undefined;
  const brightnessCrop = autoDetectSubject
    ? detection?.crop          // undefined until detection resolves
    : null;                    // no detection → full-image measurement

  const autoBrightness = useAutoBrightnessForUri( brightnessUri, brightnessCrop );

  const cropStyles = detection && containerSize
    ? computeCropStyles(
      detection.crop,
      containerSize,
      detection.imageWidth,
      detection.imageHeight,
    )
    : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brightnessStyle: any = autoBrightness !== 1.0
    ? { filter: [{ brightness: autoBrightness }] }
    : null;

  return (
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
};

export default ObsImage;
