import classNames from "classnames";
import { IconicTaxonIcon } from "components/SharedComponents";
import CachedImage from "components/SharedComponents/CachedImage";
import { View } from "components/styledComponents";
import React, {
  useCallback, useState,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
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
  // Lets a two-finger pinch zoom and pan the photo even without subject
  // detection; the photo starts whole (or at a framing the user logged
  // earlier) and a pinch is logged as its framing.
  zoomable?: boolean;
  // Hands the framing to the caller instead: the photo starts at zoomCrop
  // and a pinch reports its new framing through onZoomCropChange rather than
  // logging it (Group Photos, which crops the file itself).
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
  zoomable = false,
  zoomCrop,
  onZoomCropChange,
  brightness,
}: Props ) => {
  const [containerSize, setContainerSize] = useState<number | null>(
    initialContainerSize ?? null,
  );

  const cropControlled = !!onZoomCropChange;
  const zoomEnabled = autoDetectSubject || zoomable || cropControlled;

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const detection = useSubjectDetectionForUri(
    zoomEnabled && !cropControlled && uri?.uri
      ? uri.uri
      : undefined,
    // Without autoDetectSubject the detector never runs; only a crop the user
    // framed by hand is honored.
    { loggedCropOnly: !autoDetectSubject },
  );

  const displayUri = uri?.uri;

  // Once the tile is measured (and, with autoDetectSubject, subject detection
  // resolves) render the photo through the shared image-zoom engine so a
  // two-finger gesture zooms and pans it exactly like the crop editor,
  // MediaViewer and IDing game. A zoomable photo without detection starts out
  // whole and picks up a hand-framed crop when it resolves.
  const showZoomable = Boolean(
    ( autoDetectSubject
      ? detection
      : zoomable || cropControlled )
    && containerSize
    && uri?.uri,
  );

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
      { displayUri && !showZoomable && (
        <CachedImage
          key={uri.uri}
          className={classNames( CLASS_NAMES )}
          testID="ObsList.photo"
          source={{ uri: displayUri }}
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
        />
      ) }
      { opaque && (
        <View className="absolute w-full h-full bg-white opacity-50" />
      ) }
    </View>
  );
};

export default ObsImage;
