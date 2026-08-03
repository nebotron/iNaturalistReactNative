import DevicePhotoImage from "components/PhotoImporter/DevicePhotoImage";
import { INatIcon, INatIconButton } from "components/SharedComponents";
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
  duplicateItem: ( item: Item ) => void;
  isDuplicatingPhotos?: boolean;
  item: Item;
  removeItem: ( item: Item ) => void;
  selectedObservations: Item[];
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separateItem: ( item: Item ) => void;
  style?: ViewStyle;
}

const GroupPhotoImage = ( {
  duplicateItem,
  isDuplicatingPhotos,
  item,
  removeItem,
  selectedObservations,
  selectObservationPhotos,
  separateItem,
  style,
}: Props ) => {
  const { t } = useTranslation( );
  const firstPhoto = item.photos?.[0];
  const mediaUri = firstPhoto?.image.uri ?? item.soundUri;
  const isSelected = selectedObservations.includes( item );
  const handlePress = ( ) => selectObservationPhotos( isSelected, item );
  const mediaCount = item.photos?.length || 0;
  const hasDuplicateUpload = item.photos?.some( photo => photo.isDuplicateUpload );

  // Each grid cell carries its own separate/duplicate/remove buttons so the
  // action always applies to the photo it's drawn on, not to the selection.
  const separableItemCount = mediaCount + ( item.soundUri
    ? 1
    : 0 );
  const actionButtons = (
    <View className="absolute bottom-2 left-2 flex-row gap-2 z-20">
      {separableItemCount > 1 && (
        <INatIconButton
          icon="separate"
          mode="contained"
          size={20}
          width={44}
          height={44}
          color={colors.white}
          backgroundColor={colors.darkGray}
          accessibilityLabel={t( "Separate-Photos" )}
          onPress={( ) => separateItem( item )}
          testID={`GroupPhotos.separate.${mediaUri}`}
        />
      )}
      {mediaCount > 0 && (
        <INatIconButton
          icon="copy"
          mode="contained"
          size={20}
          width={44}
          height={44}
          color={colors.white}
          backgroundColor={colors.darkGray}
          accessibilityLabel={t( "Duplicate-Photos" )}
          disabled={isDuplicatingPhotos}
          onPress={( ) => duplicateItem( item )}
          testID={`GroupPhotos.duplicate.${mediaUri}`}
        />
      )}
      <INatIconButton
        icon="trash-outline"
        mode="contained"
        size={20}
        width={44}
        height={44}
        color={colors.white}
        backgroundColor={colors.warningRed}
        accessibilityLabel={t( "Remove-Photos" )}
        onPress={( ) => removeItem( item )}
        testID={`GroupPhotos.remove.${mediaUri}`}
      />
    </View>
  );

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
      <View className="relative">
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
        {actionButtons}
      </View>
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
          testID={`GroupPhotos.duplicateUpload.${mediaUri}`}
        />
      )}
      {actionButtons}
    </DevicePhotoImage>
  );
};

export default GroupPhotoImage;
