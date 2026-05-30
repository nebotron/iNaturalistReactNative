import classnames from "classnames";
import ObsImagePreview from "components/ObservationsFlashList/ObsImagePreview";
import { INatIcon } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import { Pressable, View } from "components/styledComponents";
import React from "react";
import type { ViewStyle } from "react-native";
import { useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

import type { LibraryPhoto } from "./types";

const ICON_DROP_SHADOW = getShadow( {
  offsetHeight: 1,
  shadowOpacity: 1,
  shadowRadius: 1,
} );

interface Props {
  isDuplicateUpload: boolean;
  isMarkedForUpload: boolean;
  isSelected: boolean;
  onPress: ( ) => void;
  photo: LibraryPhoto;
  style?: ViewStyle;
}

const PhotoLibraryGridItem = ( {
  isDuplicateUpload,
  isMarkedForUpload,
  isSelected,
  onPress,
  photo,
  style,
}: Props ) => {
  const { t } = useTranslation( );
  const showChecked = isMarkedForUpload || isSelected;
  const canToggle = !isMarkedForUpload;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{
        checked: showChecked,
        disabled: !canToggle,
      }}
      disabled={!canToggle}
      onPress={onPress}
      testID={`CustomPhotoLibrary.${photo.id}`}
      className="flex-1"
    >
      <View className="relative" style={style}>
        <ObsImagePreview
          source={{ uri: photo.asset.uri }}
          selected={isSelected}
          selectable={canToggle}
          hideGradientOverlay
          squareCorners
          style={style}
        />
        {isMarkedForUpload && (
          <View
            accessibilityLabel={t( "Previously-selected-for-upload" )}
            className={classnames(
              "absolute m-2.5 right-0 top-0",
              "flex items-center justify-center",
              "rounded-full bg-white w-[24px] h-[24px]",
            )}
            style={ICON_DROP_SHADOW}
            testID={`CustomPhotoLibrary.marked.${photo.id}`}
          >
            <INatIcon name="checkmark" color={colors.inatGreen} size={12} />
          </View>
        )}
        {isDuplicateUpload && (
          <DuplicateUploadBadge
            accessibilityLabel={t( "Duplicate-photo-indicator" )}
            className="absolute top-2 left-2 z-10"
            size={20}
            testID={`CustomPhotoLibrary.duplicate.${photo.id}`}
          />
        )}
      </View>
    </Pressable>
  );
};

export default PhotoLibraryGridItem;
