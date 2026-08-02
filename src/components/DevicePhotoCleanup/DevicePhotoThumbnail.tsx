import React from "react";
import type { ViewStyle } from "react-native";
import {
  Image,
  PixelRatio,
  StyleSheet,
  View,
} from "react-native";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";

interface Props {
  uri: string;
  size: number;
  style: ViewStyle;
}

const styles = StyleSheet.create( {
  // A neutral placeholder while the thumbnail is generated, so an asset that
  // never resolves reads as an empty cell rather than a black square.
  placeholder: {
    backgroundColor: "#E0E0E0",
    overflow: "hidden",
  },
} );

// A single device photo preview. Handing a ph:// PHAsset identifier straight to
// <Image> makes iOS decode the full-resolution original into every cell; across
// a grid of a thousand photos that starves PHImageManager and the decoded
// bitmaps get purged under memory pressure, which is what renders them black.
// Going through the shared thumbnail generator instead gives a small JPEG
// cached on disk (the same path PhotoGallery uses), so each cell shows a real
// image and stays cheap.
const DevicePhotoThumbnail = ( { uri, size, style }: Props ) => {
  const thumbnailUri = useDeviceImageThumbnail(
    uri,
    PixelRatio.getPixelSizeForLayoutSize( size ),
  );

  return (
    <View style={[style, styles.placeholder]}>
      {thumbnailUri && (
        <Image
          source={{ uri: thumbnailUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}
    </View>
  );
};

export default React.memo( DevicePhotoThumbnail );
