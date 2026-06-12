import classnames from "classnames";
import { TransparentCircleButton } from "components/SharedComponents";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import React, { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { cropImageStyle } from "sharedHelpers/normalizedCropTypes";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";
import { useTranslation } from "sharedHooks";

interface Props {
  duplicatePhotoUris?: Set<string>;
  onCropPhoto?: ( _uri: string ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
}

const PhotoThumbnail = ( { uri }: { uri: string } ) => {
  const [containerSize, setContainerSize] = useState<number | null>( null );
  const detection = useSubjectDetectionForUri( uri );

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const imageStyle = detection && containerSize
    ? cropImageStyle( detection.crop, containerSize, detection.imageWidth, detection.imageHeight )
    : null;

  return (
    <View className="w-full h-full" onLayout={handleLayout}>
      {imageStyle
        ? (
          <Image
            source={{ uri }}
            accessibilityIgnoresInvertColors
            style={imageStyle}
            resizeMode="stretch"
          />
        )
        : (
          <Image
            source={{ uri }}
            accessibilityIgnoresInvertColors
            className="w-full h-full"
          />
        )}
    </View>
  );
};

const ObsPhotoSelectionList = ( {
  duplicatePhotoUris,
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
          {duplicatePhotoUris?.has( item ) && (
            <DuplicateUploadBadge
              accessibilityLabel={t( "Duplicate-photo-indicator" )}
              className="absolute top-1 left-1 z-10"
              size={18}
              testID={`ObsPhotoSelectionList.duplicate.${item}`}
            />
          )}
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
  ), [duplicatePhotoUris, onCropPhoto, selectedPhotoUri, onPressPhoto, t] );

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
