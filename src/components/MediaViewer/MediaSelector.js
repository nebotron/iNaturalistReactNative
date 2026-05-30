// @flow

import classnames from "classnames";
import { INatIcon } from "components/SharedComponents";
import { Image, Pressable, View } from "components/styledComponents";
import type { Node } from "react";
import React, { useCallback, useMemo } from "react";
import {
  FlatList,
} from "react-native";
import DraggableFlatList, { ScaleDecorator } from "react-native-draggable-flatlist";
import Photo from "realmModels/Photo";
import useTranslation from "sharedHooks/useTranslation";

type Props = {
  editable?: boolean,
  isLargeScreen?: boolean,
  onReorderPhotos?: Function,
  photos: {
    id?: number,
    url: string,
    localFilePath?: string,
    attribution?: string,
    licenseCode?: string
  }[],
  scrollToIndex: Function,
  selectedMediaIndex?: number,
  sounds?: {
    file_url: string
  }[],
}

const SMALL_ITEM_CLASS = "rounded-sm w-[42px] h-[42px] mx-[6px] my-[12px]";
const LARGE_ITEM_CLASS = "rounded-md w-[83px] h-[83px] mx-[10px] my-[20px]";

const MediaSelector = ( {
  editable = false,
  isLargeScreen,
  onReorderPhotos,
  photos,
  scrollToIndex,
  selectedMediaIndex,
  sounds = [],
}: Props ): Node => {
  const { t } = useTranslation( );
  const itemClass = isLargeScreen
    ? LARGE_ITEM_CLASS
    : SMALL_ITEM_CLASS;

  const photoUris = useMemo(
    ( ) => photos
      .map( photo => Photo.displayLocalOrRemoteSquarePhoto( photo ) )
      .filter( Boolean ),
    [photos],
  );

  const items = useMemo( ( ) => [
    ...photos.map( photo => ( { ...photo, type: "photo" } ) ),
    ...sounds.map( sound => ( { ...sound, type: "sound" } ) ),
  ], [photos, sounds] );

  const renderSoundFooter = useCallback( ( ) => {
    if ( sounds.length === 0 ) {
      return null;
    }

    return (
      <View className="flex-row">
        {sounds.map( ( sound, index ) => {
          const mediaIndex = photos.length + index;
          return (
            <Pressable
              key={sound.file_url}
              accessibilityRole="button"
              accessibilityLabel="Sound"
              onPress={( ) => scrollToIndex( mediaIndex )}
              className={classnames(
                "overflow-hidden",
                {
                  "border border-white border-[3px]": selectedMediaIndex === mediaIndex,
                },
                itemClass,
              )}
            >
              <View className="w-full h-full bg-darkGray items-center justify-center">
                <INatIcon
                  name="sound-outline"
                  color="white"
                  size={26}
                />
              </View>
            </Pressable>
          );
        } )}
      </View>
    );
  }, [
    itemClass,
    photos.length,
    scrollToIndex,
    selectedMediaIndex,
    sounds,
    t,
  ] );

  const renderMediaItem = useCallback( ( { item, index } ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.type === "photo"
        ? t( "View-photo" )
        : t( "View-sound" )}
      onPress={( ) => scrollToIndex( index )}
      className={classnames(
        "overflow-hidden",
        {
          "border border-white border-[3px]": selectedMediaIndex === index,
        },
        itemClass,
      )}
    >
      {
        item.type === "photo"
          ? (
            <Image
              source={{ uri: Photo.displayLocalOrRemoteSquarePhoto( item ) }}
              accessibilityIgnoresInvertColors
              className="w-full h-full"
            />
          )
          : (
            <View className="w-full h-full bg-darkGray items-center justify-center">
              <INatIcon
                name="sound-outline"
                color="white"
                size={26}
              />
            </View>
          )
      }
    </Pressable>
  ), [
    itemClass,
    scrollToIndex,
    selectedMediaIndex,
    t,
  ] );

  const renderDraggablePhoto = useCallback( ( { item: photoUri, drag } ) => {
    const index = photoUris.indexOf( photoUri );

    return (
      <ScaleDecorator>
        <Pressable
          onLongPress={drag}
          accessibilityRole="button"
          accessibilityLabel={t( "Select-or-drag-media" )}
          onPress={( ) => scrollToIndex( index )}
          className={classnames(
            "overflow-hidden",
            {
              "border border-white border-[3px]": selectedMediaIndex === index,
            },
            itemClass,
          )}
          testID={`MediaSelector.${photoUri}`}
        >
          <Image
            source={{ uri: photoUri }}
            accessibilityIgnoresInvertColors
            className="w-full h-full"
          />
        </Pressable>
      </ScaleDecorator>
    );
  }, [
    itemClass,
    photoUris,
    scrollToIndex,
    selectedMediaIndex,
    t,
  ] );

  const canReorderPhotos = editable
    && !!onReorderPhotos
    && photoUris.length > 1;

  if ( canReorderPhotos ) {
    return (
      <View>
        <DraggableFlatList
          testID="MediaSelector.DraggableFlatList"
          horizontal
          data={photoUris}
          keyExtractor={photoUri => photoUri}
          renderItem={renderDraggablePhoto}
          onDragEnd={onReorderPhotos}
          ListFooterComponent={renderSoundFooter}
        />
      </View>
    );
  }

  return (
    <View>
      <FlatList
        testID="MediaSelector.FlatList"
        data={items}
        keyExtractor={( item, index ) => item.url || item.file_url || `media-${index}`}
        renderItem={renderMediaItem}
        horizontal
      />
    </View>
  );
};

export default MediaSelector;
