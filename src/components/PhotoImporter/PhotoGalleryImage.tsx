import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { PixelRatio, Text } from "react-native";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";
import { useTranslation } from "sharedHooks";

type PhotoNode = PhotoIdentifier["node"];

interface Props {
  node: PhotoNode;
  selectionKey: string;
  selected: boolean;
  imported: boolean;
  isVideo: boolean;
  cellWidth: number;
  gridItemStyle: ViewStyle;
  onPress: ( node: PhotoNode ) => void;
}

const PhotoGalleryImage = ( {
  node,
  selectionKey,
  selected,
  imported,
  isVideo,
  cellWidth,
  gridItemStyle,
  onPress,
}: Props ) => {
  const { t } = useTranslation( );

  // Render a small cached thumbnail rather than decoding the full-resolution
  // original into every cell, which janks scrolling. Sized to the grid cell so
  // it stays crisp. On iOS ph:// PHAssets resolve through PHImageManager's fast
  // pre-rendered thumbnails; on platforms without the native generator the hook
  // falls back to the original uri.
  const thumbMaxPixel = PixelRatio.getPixelSizeForLayoutSize( cellWidth || 128 );
  const thumbnailUri = useDeviceImageThumbnail( node.image.uri, thumbMaxPixel );

  const source = thumbnailUri
    ? { uri: thumbnailUri }
    : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={( ) => onPress( node )}
      testID={`PhotoGallery.${selectionKey}`}
    >
      <View className="relative">
        <ObsImagePreview
          source={source}
          selected={selected}
          selectable
          hideGradientOverlay
          squareCorners
          style={gridItemStyle}
        />
        {isVideo && (
          <View className="absolute bottom-1 right-1 z-10 bg-black/60 px-1 rounded">
            { /* eslint-disable-next-line
              react-native/no-inline-styles, i18next/no-literal-string */ }
            <Text style={{ color: "white", fontSize: 10 }}>▶ GIF</Text>
          </View>
        )}
        {imported && (
          <DuplicateUploadBadge
            accessibilityLabel={t( "Duplicate-photo-indicator" )}
            className="absolute top-2 left-2 z-10"
            size={20}
            testID={`PhotoGallery.imported.${selectionKey}`}
          />
        )}
      </View>
    </Pressable>
  );
};

export default PhotoGalleryImage;
