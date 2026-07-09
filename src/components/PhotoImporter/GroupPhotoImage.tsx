import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { INatIcon } from "components/SharedComponents";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import useTranslation from "sharedHooks/useTranslation";
import colors from "styles/tailwindColors";

interface PhotoItem {
  image: {
    uri: string;
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

  if ( item.soundUri ) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={handlePress}
        testID={`GroupPhotos.${mediaUri}`}
      >
        <View
          className="items-center justify-center bg-lightGray"
          style={[style, isSelected && { borderWidth: 4, borderColor: colors.inatGreen }]}
        >
          <INatIcon name="sound" size={32} color={colors.darkGray} />
        </View>
      </Pressable>
    );
  }

  const source = firstPhoto && { uri: firstPhoto.image.uri };

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
