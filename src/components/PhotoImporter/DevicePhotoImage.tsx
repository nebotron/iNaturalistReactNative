import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { Pressable, View } from "components/styledComponents";
import type { ReactNode } from "react";
import React from "react";
import type { ViewStyle } from "react-native";
import { PixelRatio } from "react-native";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";

interface Props {
  // Device photo library uri (ph:// on iOS) or a local file:// path
  uri?: string;
  // Shown until the thumbnail is ready, for photos whose original must always
  // be visible (e.g. a baked crop). Left undefined, the cell shows a
  // placeholder rather than decoding a full-resolution original while
  // scrolling.
  fallbackUri?: string;
  // Laid-out width of the cell, used to size the generated thumbnail
  cellWidth: number;
  style?: ViewStyle;
  selectable?: boolean;
  selected?: boolean;
  obsPhotosCount?: number;
  onPress?: ( ) => void;
  accessibilityLabel?: string;
  testID?: string;
  // Badges and overlays, absolutely positioned over the image
  children?: ReactNode;
  // Drawn over the photo but under the selection indicator and children
  imageOverlay?: ReactNode;
}

// A single square device-photo cell, shared by every grid that renders photos
// straight from the device library (the photo picker, Group Photos, the
// unfavorited-photo cleanup screen). Rendering a small cached thumbnail rather
// than decoding the full-resolution original into every cell is what keeps
// those grids scrolling; see useDeviceImageThumbnail for the scheduling.
const DevicePhotoImage = ( {
  uri,
  fallbackUri,
  cellWidth,
  style,
  selectable = false,
  selected = false,
  obsPhotosCount,
  onPress,
  accessibilityLabel,
  testID,
  children,
  imageOverlay,
}: Props ) => {
  const thumbMaxPixel = PixelRatio.getPixelSizeForLayoutSize( cellWidth || 128 );
  const thumbnailUri = useDeviceImageThumbnail( uri, thumbMaxPixel );
  const displayUri = thumbnailUri ?? fallbackUri;
  const source = displayUri
    ? { uri: displayUri }
    : undefined;

  const image = (
    <View className="relative">
      <ObsImagePreview
        source={source}
        selected={selected}
        selectable={selectable}
        obsPhotosCount={obsPhotosCount}
        hideGradientOverlay
        squareCorners
        style={style}
        imageOverlay={imageOverlay}
      />
      {children}
    </View>
  );

  if ( !onPress ) {
    return image;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      testID={testID}
    >
      {image}
    </Pressable>
  );
};

export default DevicePhotoImage;
