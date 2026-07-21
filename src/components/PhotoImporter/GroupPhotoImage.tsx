import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { INatIcon } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { PixelRatio, StyleSheet } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import useDeviceImageThumbnail from "sharedHelpers/useDeviceImageThumbnail";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

const styles = StyleSheet.create( {
  selectedBorder: {
    borderWidth: 4,
    borderColor: colors.inatGreen,
  },
} );

interface PhotoItem {
  image: {
    uri: string;
    crop?: NormalizedCrop;
  };
  isDuplicateUpload?: boolean;
}

interface Item {
  photos?: PhotoItem[];
  soundUri?: string;
}

interface Props {
  item: Item;
  selectedObservations: Item[];
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  style?: ViewStyle;
}

const GroupPhotoImage = ( {
  item,
  selectedObservations,
  selectObservationPhotos,
  style,
}: Props ) => {
  const { t } = useTranslation( );
  const firstPhoto = item.photos?.[0];
  const mediaUri = firstPhoto?.image.uri ?? item.soundUri;
  const isSelected = selectedObservations.includes( item );
  const handlePress = ( ) => selectObservationPhotos( isSelected, item );
  const mediaCount = item.photos?.length || 0;
  const hasDuplicateUpload = item.photos?.some( photo => photo.isDuplicateUpload );

  // Render a small cached thumbnail rather than decoding the full-resolution
  // original into every cell, which janks scrolling. Sized to the grid cell so
  // it stays crisp.
  const cellWidth = typeof style?.width === "number"
    ? style.width
    : 0;
  const thumbMaxPixel = PixelRatio.getPixelSizeForLayoutSize( cellWidth || 128 );
  const thumbnailUri = useDeviceImageThumbnail( firstPhoto?.image.uri, thumbMaxPixel );

  // A cropped photo must always show its crop, so fall back to the cropped
  // file (image.uri already points at the baked crop) until the thumbnail is
  // ready rather than flashing a placeholder. Large uncropped originals keep
  // waiting on the thumbnail so scrolling doesn't decode them full-resolution.
  const hasCrop = Boolean( firstPhoto?.image.crop );
  const displayUri = thumbnailUri
    ?? ( hasCrop
      ? firstPhoto?.image.uri
      : undefined );

  if ( item.soundUri ) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        testID={`GroupPhotos.${mediaUri}`}
      >
        <View
          className="items-center justify-center bg-lightGray"
          style={[style, isSelected && styles.selectedBorder]}
        >
          <INatIcon name="sound" size={32} color={colors.darkGray} />
        </View>
      </Pressable>
    );
  }

  const source = displayUri
    ? { uri: displayUri }
    : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      testID={`GroupPhotos.${mediaUri}`}
    >
      <View className="relative">
        <ObsImagePreview
          source={source}
          selected={isSelected}
          obsPhotosCount={mediaCount}
          selectable
          hideGradientOverlay
          squareCorners
          style={style}
        />
        {hasDuplicateUpload && (
          <DuplicateUploadBadge
            accessibilityLabel={t( "Duplicate-photo-indicator" )}
            className="absolute top-2 left-2 z-10"
            size={20}
            testID={`GroupPhotos.duplicate.${mediaUri}`}
          />
        )}
      </View>
    </Pressable>
  );
};

export default GroupPhotoImage;
