import type { PhotoIdentifier } from "@react-native-camera-roll/camera-roll";
import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { View } from "components/styledComponents";
import React, { useCallback } from "react";
import type { ViewStyle } from "react-native";
import { Text } from "react-native";
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
  const handlePress = useCallback( ( ) => onPress( node ), [node, onPress] );

  return (
    <DevicePhotoImage
      uri={node.image.uri}
      cellWidth={cellWidth}
      style={gridItemStyle}
      selectable
      selected={selected}
      onPress={handlePress}
      testID={`PhotoGallery.${selectionKey}`}
    >
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
    </DevicePhotoImage>
  );
};

export default PhotoGalleryImage;
