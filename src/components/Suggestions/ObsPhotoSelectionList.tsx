import classnames from "classnames";
import DuplicateUploadBadge from
  "components/SharedComponents/DuplicateUploadBadge/DuplicateUploadBadge";
import {
  Image, Pressable, View,
} from "components/styledComponents";
import React, { useCallback, useRef } from "react";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import { useTranslation } from "sharedHooks";

interface Props {
  duplicatePhotoUris?: Set<string>;
  photoUris: string[];
  selectedPhotoUri: string;
  onPressPhoto: ( _uri: string ) => void;
  onDoubleTapPhoto?: ( _uri: string ) => void;
  onReorderPhotos?: ( _data: { data: string[] } ) => void;
}

const DOUBLE_TAP_DELAY = 300;

const ObsPhotoSelectionList = ( {
  duplicatePhotoUris,
  photoUris,
  selectedPhotoUri,
  onPressPhoto,
  onDoubleTapPhoto,
  onReorderPhotos,
}: Props ) => {
  const { t } = useTranslation( );
  const lastTapRef = useRef<{ uri: string; time: number } | null>( null );

  const handlePress = useCallback( ( item: string ) => {
    const now = Date.now( );
    if (
      lastTapRef.current?.uri === item
      && now - lastTapRef.current.time < DOUBLE_TAP_DELAY
    ) {
      lastTapRef.current = null;
      onDoubleTapPhoto?.( item );
    } else {
      lastTapRef.current = { uri: item, time: now };
      onPressPhoto( item );
    }
  }, [onPressPhoto, onDoubleTapPhoto] );

  const renderPhoto = useCallback( ( { item, drag } ) => (
    <ScaleDecorator>
      <Pressable
        accessibilityRole="button"
        onPress={( ) => handlePress( item )}
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
    </ScaleDecorator>
  ), [duplicatePhotoUris, selectedPhotoUri, handlePress, t] );

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
