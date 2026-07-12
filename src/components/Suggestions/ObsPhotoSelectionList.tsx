import classnames from "classnames";
import { TransparentCircleButton } from "components/SharedComponents";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import React, { useCallback } from "react";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { useTranslation } from "sharedHooks";

interface Props {
  onCropPhoto?: ( _uri: string ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
}

const PhotoThumbnail = ( { uri }: { uri: string } ) => (
  <View className="w-full aspect-square">
    <Image
      source={{ uri }}
      accessibilityIgnoresInvertColors
      className="w-full h-full"
    />
  </View>
);

const ObsPhotoSelectionList = ( {
  onCropPhoto,
  photoUris, selectedPhotoUri, onPressPhoto, onReorderPhotos,
}: Props ) => {
  const { t } = useTranslation( );

  const renderPhoto = useCallback( ( { item, drag } ) => (
    <ScaleDecorator>
      <Pressable
        accessibilityRole="button"
        onPress={( ) => {
          onPressPhoto( item );
        }}
        onLongPress={drag}
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
          <PhotoThumbnail uri={item} />
          {selectedPhotoUri === item && onCropPhoto && (
            <TransparentCircleButton
              onPress={( ) => onCropPhoto( item )}
              icon="crop"
              accessibilityLabel={t( "CROP-PHOTO" )}
              testID={`ObsPhotoSelectionList.crop.${item}`}
              optionalClasses="absolute bottom-1 right-1 z-10"
            />
          )}
        </View>
      </Pressable>
    </ScaleDecorator>
  ), [onCropPhoto, selectedPhotoUri, onPressPhoto, t] );

  return (
    <DraggableFlatList
      data={photoUris}
      renderItem={renderPhoto}
      keyExtractor={uri => uri}
      horizontal
      onDragEnd={onReorderPhotos ?? ( ( ) => undefined )}
    />
  );
};

export default ObsPhotoSelectionList;
