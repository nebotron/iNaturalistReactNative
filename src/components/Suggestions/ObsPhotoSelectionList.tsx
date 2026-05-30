import classnames from "classnames";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import React, { useCallback } from "react";
import { FlatList } from "react-native";
import { useTranslation } from "sharedHooks";

interface Props {
  duplicatePhotoUris?: Set<string>;
  photoUris: string[];
  selectedPhotoUri: string;
  onPressPhoto: ( _uri: string ) => void;
}

const ObsPhotoSelectionList = ( {
  duplicatePhotoUris,
  photoUris, selectedPhotoUri, onPressPhoto,
}: Props ) => {
  const { t } = useTranslation( );

  const renderPhoto = useCallback( ( { item } ) => (
    <Pressable
      accessibilityRole="button"
      onPress={( ) => {
        onPressPhoto( item );
      }}
      className={classnames(
        "w-[83px] h-[83px] justify-center mx-1.5 rounded-lg",
      )}
      accessibilityLabel={t( "Select-photo" )}
      testID={`ObsPhotoSelectionList.${item}`}
    >
      <View
        className={classnames(
          "rounded-lg overflow-hidden relative",
          {
            "border-inatGreen border-[3px]": selectedPhotoUri === item,
          },
        )}
        testID={`ObsPhotoSelectionList.border.${item}`}
      >
        <Image
          source={{ uri: item }}
          accessibilityIgnoresInvertColors
          className="w-full h-full"
        />
        {duplicatePhotoUris?.has( item ) && (
          <DuplicateUploadBadge
            accessibilityLabel={t( "Duplicate-photo-indicator" )}
            className="absolute top-1 left-1 z-10"
            size={18}
            testID={`ObsPhotoSelectionList.duplicate.${item}`}
          />
        )}
      </View>
    </Pressable>
  ), [duplicatePhotoUris, selectedPhotoUri, onPressPhoto, t] );

  return (
    <FlatList
      data={photoUris}
      renderItem={renderPhoto}
      horizontal
    />
  );
};

export default ObsPhotoSelectionList;
