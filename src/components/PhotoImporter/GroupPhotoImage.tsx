import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import { INatIcon } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { StyleSheet } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
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

  const cellWidth = typeof style?.width === "number"
    ? style.width
    : 0;

  // A cropped photo must always show its crop, so fall back to the cropped
  // file (image.uri already points at the baked crop) until the thumbnail is
  // ready rather than flashing a placeholder. Large uncropped originals keep
  // waiting on the thumbnail so scrolling doesn't decode them full-resolution.
  const hasCrop = Boolean( firstPhoto?.image.crop );

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

  return (
    <DevicePhotoImage
      uri={firstPhoto?.image.uri}
      fallbackUri={hasCrop
        ? firstPhoto?.image.uri
        : undefined}
      cellWidth={cellWidth}
      style={style}
      selectable
      selected={isSelected}
      obsPhotosCount={mediaCount}
      onPress={handlePress}
      testID={`GroupPhotos.${mediaUri}`}
    >
      {hasDuplicateUpload && (
        <DuplicateUploadBadge
          accessibilityLabel={t( "Duplicate-photo-indicator" )}
          className="absolute top-2 left-2 z-10"
          size={20}
          testID={`GroupPhotos.duplicate.${mediaUri}`}
        />
      )}
    </DevicePhotoImage>
  );
};

export default GroupPhotoImage;
