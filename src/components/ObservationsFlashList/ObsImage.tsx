import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { View } from "components/styledComponents";
import React, {
  useCallback, useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import { PixelRatio } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import photoUriForPixelSize from "sharedHelpers/photoUriForPixelSize";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";

import ObsImageZoomable from "./ObsImageZoomable";

interface Props {
  autoDetectSubject?: boolean;
  // Shrink a non-square photo to fit the square instead of cropping it
  fitImage?: boolean;
  iconicTaxonIconSize?: number;
  iconicTaxonName?: string;
  imageClassName?: string;
  initialContainerSize?: number;
  isBackground?: boolean;
  onError?: ( ) => void;
  opaque?: boolean;
  uri?: {
    uri: string;
  };
  white?: boolean;
  // Lets a two-finger pinch zoom and pan the photo, starting at zoomCrop and
  // reporting its new framing through onZoomCropChange (Group Photos, which
  // crops the file itself).
  zoomCrop?: NormalizedCrop | null;
  onZoomCropChange?: ( crop: NormalizedCrop ) => void;
  // Exposure multiplier drawn over a zoomable photo (1 = unchanged)
  brightness?: number;
}

const CLASS_NAMES = [
  "grow",
  "aspect-square",
] as const;

const ObsImage = ( {
  autoDetectSubject = false,
  fitImage = false,
  iconicTaxonName,
  imageClassName,
  initialContainerSize,
  isBackground = false,
  onError,
  opaque = false,
  uri,
  white = false,
  iconicTaxonIconSize,
  zoomCrop,
  onZoomCropChange,
  brightness,
}: Props ) => {
  const [containerSize, setContainerSize] = useState<number | null>(
    initialContainerSize ?? null,
  );

  const cropControlled = !!onZoomCropChange;
  const zoomEnabled = autoDetectSubject || cropControlled;

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const detection = useSubjectDetectionForUri(
    autoDetectSubject && !cropControlled && uri?.uri
      ? uri.uri
      : undefined,
  );

  const displayUri = uri?.uri;

  // The uri whose zoomable image has finished loading
  const [zoomLoadedUri, setZoomLoadedUri] = useState<string | null>( null );
  const handleZoomLoad = useCallback( ( ) => {
    setZoomLoadedUri( displayUri ?? null );
  }, [displayUri] );
  // The uri last drawn as a plain image, before the tile was measured or
  // subject detection resolved
  const [plainShownUri, setPlainShownUri] = useState<string | null>( null );

  // Once the tile is measured (and, with autoDetectSubject, subject detection
  // resolves) render the photo through the shared image-zoom engine so a
  // two-finger gesture zooms and pans it exactly like the crop editor,
  // MediaViewer and IDing game.
  const showZoomable = Boolean(
    ( autoDetectSubject
      ? detection
      : cropControlled )
    && containerSize
    && uri?.uri,
  );

  // Keep the plain image under the zoomable one until the zoomable one has
  // loaded, so swapping between them doesn't flash the placeholder icon.
  if ( displayUri && !showZoomable && plainShownUri !== displayUri ) {
    setPlainShownUri( displayUri );
  }
  const showPlain = !!displayUri && (
    !showZoomable
    || ( plainShownUri === displayUri && zoomLoadedUri !== displayUri )
  );
  // A tile of known size only needs the photo at the size it's drawn at:
  // download the smallest iNaturalist variant that covers it and decode no
  // more pixels than it shows (see ObsImageZoomable)
  const tilePx = containerSize && !cropControlled
    ? Math.ceil( containerSize * PixelRatio.get( ) )
    : null;
  const plainUri = displayUri && tilePx
    ? photoUriForPixelSize( displayUri, tilePx )
    : displayUri;

  return (
    <View
      className={classNames( CLASS_NAMES, "relative overflow-hidden" )}
      onLayout={zoomEnabled
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
      { showPlain && (
        <CachedImage
          key={uri.uri}
          className={classNames( CLASS_NAMES, showZoomable && "absolute" )}
          testID={showZoomable
            ? undefined
            : "ObsList.photo"}
          source={{ uri: plainUri }}
          // The long side fills the tile when contained; covering a square
          // stretches it past the tile, so leave room for oblong photos
          maxPixelSize={tilePx
            ? tilePx * ( fitImage
              ? 1
              : 2 )
            : undefined}
          onError={onError}
          resizeMode={fitImage
            ? "contain"
            : "cover"}
        />
      ) }
      { showZoomable && displayUri && containerSize && (
        <ObsImageZoomable
          key={uri?.uri}
          uri={displayUri}
          // Group Photos frames the file itself, so it's drawn at full resolution
          fullResolution={cropControlled}
          logUri={cropControlled
            ? undefined
            : uri.uri}
          imageWidth={detection?.imageWidth}
          imageHeight={detection?.imageHeight}
          initialCrop={cropControlled
            ? zoomCrop
            : detection?.crop}
          followCrop={cropControlled}
          onCropChange={onZoomCropChange}
          size={containerSize}
          brightness={brightness}
          onLoad={handleZoomLoad}
        />
      ) }
      { opaque && (
        <View className="absolute w-full h-full bg-white opacity-50" />
      ) }
    </View>
  );
};

export default ObsImage;
