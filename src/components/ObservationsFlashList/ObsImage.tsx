import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import { FasterImageView, View } from "components/styledComponents";
import React, { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { cropImageStyle } from "sharedHelpers/normalizedCropTypes";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";

interface Props {
  autoDetectSubject?: boolean;
  iconicTaxonIconSize?: number;
  iconicTaxonName?: string;
  imageClassName?: string;
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
  autoDetectSubject = false,
  iconicTaxonName,
  imageClassName,
  isBackground = false,
  opaque = false,
  uri,
  white = false,
  iconicTaxonIconSize,
}: Props ) => {
  const [containerSize, setContainerSize] = useState<number | null>( null );

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const detection = useSubjectDetectionForUri(
    autoDetectSubject && uri?.uri
      ? uri.uri
      : undefined,
  );

  const imageStyle = detection && containerSize
    ? cropImageStyle(
      detection.crop,
      containerSize,
      detection.imageWidth,
      detection.imageHeight,
    )
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
      { uri?.uri && !imageStyle && (
        <FasterImageView
          className={classNames( CLASS_NAMES )}
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
      { uri?.uri && imageStyle && (
        <FasterImageView
          testID="ObsList.photo"
          accessibilityIgnoresInvertColors
          fadeDuration={0}
          style={imageStyle}
          source={{
            url: uri.uri,
            cachePolicy: "discWithCacheControl",
            resizeMode: "stretch",
          }}
        />
      ) }
      { opaque && (
        <View className="absolute w-full h-full bg-white opacity-50" />
      ) }
    </View>
  );
};

export default ObsImage;
