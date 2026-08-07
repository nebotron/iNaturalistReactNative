import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import { FasterImageView, Image, View } from "components/styledComponents";
import React, {
  useCallback, useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";

import ObsImageZoomable from "./ObsImageZoomable";

interface Props {
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

  const displayUri = uri?.uri;

  // Once subject detection resolves and the tile is measured, render the
  // photo through the shared image-zoom engine so a two-finger gesture zooms
  // and pans it exactly like the crop editor, MediaViewer and IDing game.
  const showZoomable = Boolean(
    autoDetectSubject && detection && containerSize && uri?.uri,
  );

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
      { displayUri && !showZoomable && (
        displayUri.startsWith( "ph://" )
          // FasterImageView (SDWebImage) can't load ph:// PHAsset identifiers;
          // only React Native's own Image loader resolves those on iOS.
          ? (
            <Image
              key={uri.uri}
              className={classNames( CLASS_NAMES )}
              testID="ObsList.photo"
              resizeMode="cover"
              source={{ uri: displayUri }}
            />
          )
          : (
            <FasterImageView
              key={uri.uri}
              className={classNames( CLASS_NAMES )}
              testID="ObsList.photo"
              accessibilityIgnoresInvertColors
              fadeDuration={0}
              source={{
                url: displayUri,
                cachePolicy: "discWithCacheControl",
                resizeMode: "cover",
              }}
            />
          )
      ) }
      { showZoomable && detection && displayUri && containerSize && (
        <ObsImageZoomable
          key={uri?.uri}
          uri={displayUri}
          logUri={uri.uri}
          imageWidth={detection.imageWidth}
          imageHeight={detection.imageHeight}
          initialCrop={detection.crop}
          size={containerSize}
        />
      ) }
      { opaque && (
        <View className="absolute w-full h-full bg-white opacity-50" />
      ) }
    </View>
  );
};

export default ObsImage;
