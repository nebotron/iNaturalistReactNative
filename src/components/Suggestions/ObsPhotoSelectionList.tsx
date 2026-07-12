import classnames from "classnames";
import { TransparentCircleButton } from "components/SharedComponents";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import React, { useCallback, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { computeCropStyles } from "sharedHelpers/normalizedCropTypes";
import useSubjectDetectionForUri from "sharedHelpers/useSubjectDetectionForUri";
import { useTranslation } from "sharedHooks";

interface Props {
  onCropPhoto?: ( _uri: string ) => void;
  photoUris: string[];
  selectedPhotoUri: string;
  onPressPhoto: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
}

const PhotoThumbnail = ( { uri }: { uri: string } ) => {
  const [containerSize, setContainerSize] = useState<number | null>( null );
  // Frame the thumbnail with the subject detector bounding box by default, or
  // the crop log entry if one exists.
  const detection = useSubjectDetectionForUri( uri );

  const handleLayout = useCallback( ( event: LayoutChangeEvent ) => {
    setContainerSize( event.nativeEvent.layout.width );
  }, [] );

  const cropStyles = detection && containerSize
    ? computeCropStyles(
      detection.crop,
      containerSize,
      detection.imageWidth,
      detection.imageHeight,
    )
    : null;

  return (
    // aspect-square (not h-full) guarantees a definite square box: h-full never
    // resolves here because the ancestors hug their content, so once the crop
    // wrapper (position: absolute) is the only child the box would otherwise
    // collapse or inherit the image's aspect ratio, shifting/over-zooming the
    // crop that computeCropStyles frames assuming a square box.
    <View className="w-full aspect-square" onLayout={handleLayout}>
      {cropStyles
        ? (
          <View style={cropStyles.wrapperStyle}>
            <Image
              source={{ uri }}
              accessibilityIgnoresInvertColors
              style={cropStyles.imageStyle}
              resizeMode="stretch"
            />
          </View>
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
