import { useNavigation } from "@react-navigation/native";
import type {
  FlashListProps, FlashListRef, ListRenderItem, ViewToken,
} from "@shopify/flash-list";
import { MAX_PHOTOS_ALLOWED } from "components/Camera/StandardCamera/StandardCamera";
import {
  Body2,
  Button,
  CustomFlashList,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import React, { useCallback, useEffect, useMemo } from "react";
import { preloadImage } from "sharedHelpers/imageCropPreload";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { useGridLayout, useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

import GroupPhotoImage from "./GroupPhotoImage";
import flattenAndOrderSelectedPhotos from "./helpers/groupPhotoHelpers";

const DROP_SHADOW = getShadow( { offsetHeight: -2 } );

const emptyItemStyle = {
  borderWidth: 4,
  borderStyle: "dashed",
  borderColor: colors.mediumGray,
} as const;

interface PhotoItem {
  image: {
    uri: string;
    cropOriginalUri?: string;
    crop?: NormalizedCrop;
  };
}

interface Item {
  photos?: PhotoItem[];
  soundUri?: string;
}

type GroupPhotosListItem = Item | { empty: true };

function isEmptyGridItem( item: GroupPhotosListItem ): item is { empty: true } {
  return "empty" in item && item.empty === true;
}

interface Props {
  combinePhotos: ( ) => void;
  clearSelection: ( ) => void;
  duplicateItem: ( item: Item ) => void;
  flashListRef?: React.RefObject<FlashListRef<GroupPhotosListItem> | null>;
  groupedPhotos: Item[];
  isCreatingObservations?: boolean;
  isDuplicatingPhotos?: boolean;
  navBasedOnUserSettings: ( ) => void;
  onScroll?: FlashListProps<GroupPhotosListItem>["onScroll"];
  onViewableItemsChanged?: ( info: {
    viewableItems: ViewToken<GroupPhotosListItem>[];
    changed: ViewToken<GroupPhotosListItem>[];
  } ) => void;
  removeItem: ( item: Item ) => void;
  selectedObservations: Item[];
  selectAllPhotos: ( ) => void;
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separateItem: ( item: Item ) => void;
  totalPhotos: number;
}

const GroupPhotos = ( {
  combinePhotos,
  clearSelection,
  duplicateItem,
  flashListRef,
  groupedPhotos,
  isCreatingObservations,
  isDuplicatingPhotos,
  navBasedOnUserSettings,
  onScroll,
  onViewableItemsChanged,
  removeItem,
  selectedObservations,
  selectAllPhotos,
  selectObservationPhotos,
  separateItem,
  totalPhotos,
}: Props ) => {
  const { t } = useTranslation( );
  const navigation = useNavigation( );
  const {
    flashListStyle,
    gridItemStyle,
    numColumns,
  } = useGridLayout( undefined, "fullWidth" );
  const extractKey = ( item: GroupPhotosListItem, index: number ) => (
    isEmptyGridItem( item )
      ? "empty"
      : `${item.photos?.[0]?.image.uri ?? item.soundUri ?? ""}${index}`
  );

  const noObsSelected = selectedObservations.length === 0;
  const oneObsSelected = selectedObservations.length === 1;
  const selectedPhotoUris = useMemo(
    ( ) => flattenAndOrderSelectedPhotos( selectedObservations )
      .map( photo => photo.image.uri ),
    [selectedObservations],
  );
  const canCropSelectedPhotos = selectedPhotoUris.length > 0;

  // Preload the first selected image as soon as it's selected so its data is
  // usually ready by the time the user taps crop. The remaining images are
  // preloaded in the background by ImageCropEditor once the first is ready,
  // so their loads don't contend with the first image's. preloadImage caches
  // and dedupes, so re-running on selection changes is cheap.
  useEffect( ( ) => {
    const [firstPhoto] = flattenAndOrderSelectedPhotos( selectedObservations );
    if ( firstPhoto ) {
      const { uri, cropOriginalUri, crop } = firstPhoto.image;
      preloadImage( uri, cropOriginalUri || uri, crop ?? null );
    }
  }, [selectedObservations] );

  const cropSelectedPhotos = useCallback( () => {
    if ( selectedPhotoUris.length === 0 ) {
      return;
    }
    const [firstUri, ...remainingUris] = selectedPhotoUris;
    navigation.navigate( "ImageCropEditor", {
      imageUri: firstUri,
      pendingImageUris: remainingUris.length > 0
        ? remainingUris
        : undefined,
      context: "groupPhotos",
      onCropSaved: clearSelection,
    } );
  }, [clearSelection, navigation, selectedPhotoUris] );

  const allPhotosSelected = groupedPhotos.length > 0
    && selectedObservations.length === groupedPhotos.length;

  const toggleSelectAll = useCallback( ( ) => {
    if ( allPhotosSelected ) {
      clearSelection( );
    } else {
      selectAllPhotos( );
    }
  }, [allPhotosSelected, clearSelection, selectAllPhotos] );

  const renderImage = useCallback( ( item: Item ) => (
    <GroupPhotoImage
      duplicateItem={duplicateItem}
      isDuplicatingPhotos={isDuplicatingPhotos}
      item={item}
      removeItem={removeItem}
      selectedObservations={selectedObservations}
      selectObservationPhotos={selectObservationPhotos}
      separateItem={separateItem}
      style={gridItemStyle}
    />
  ), [
    duplicateItem,
    gridItemStyle,
    isDuplicatingPhotos,
    removeItem,
    selectedObservations,
    selectObservationPhotos,
    separateItem,
  ] );

  const addPhotos = useCallback( () => {
    navigation.navigate( "PhotoLibrary", { fromGroupPhotos: true } );
  }, [navigation] );

  const renderItem: ListRenderItem<GroupPhotosListItem> = useCallback( ( { item } ) => {
    if ( isEmptyGridItem( item ) ) {
      return (
        <Pressable
          accessibilityRole="button"
          onPress={addPhotos}
          className="justify-center items-center"
          // Sorry, couldn't get this to work with tailwind
          style={[gridItemStyle, emptyItemStyle]}
        >
          <INatIcon name="plus" size={50} color={colors.mediumGray} />
        </Pressable>
      );
    }
    return renderImage( item );
  }, [gridItemStyle, renderImage, addPhotos] );

  const headerComponent = useMemo( ( ) => (
    <View className="m-5">
      <Body2>{t( "Group-photos-onboarding" )}</Body2>
    </View>
  ), [t] );

  const data = useMemo( (): GroupPhotosListItem[] => {
    const newData: GroupPhotosListItem[] = [...groupedPhotos];
    if ( totalPhotos < MAX_PHOTOS_ALLOWED ) {
      newData.push( { empty: true } );
    }
    return newData;
  }, [groupedPhotos, totalPhotos] );

  const extraData = {
    selectedObservations,
  };

  return (
    <SharedStackViewWrapper>
      <CustomFlashList
        ListHeaderComponent={headerComponent}
        contentContainerStyle={flashListStyle}
        data={data}
        extraData={extraData}
        key={numColumns}
        keyExtractor={extractKey}
        numColumns={numColumns}
        onScroll={onScroll}
        onViewableItemsChanged={onViewableItemsChanged}
        ref={flashListRef}
        renderItem={renderItem}
        testID="GroupPhotos.list"
      />
      <View
        className="absolute bottom-0 w-full bg-white z-50 items-center px-2 pt-2 pb-4"
        style={DROP_SHADOW}
      >
        {groupedPhotos.length > 0 && (
          <View className="flex-row w-full gap-2 mb-2">
            <View className="flex-1 items-center">
              <INatIconButton
                icon="check"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.darkGray}
                accessibilityLabel={
                  allPhotosSelected
                    ? t( "Deselect-all-photos" )
                    : t( "Select-all-photos" )
                }
                onPress={toggleSelectAll}
                testID="GroupPhotos.selectAll"
              />
            </View>
            <View className="flex-1 items-center">
              <INatIconButton
                icon="crop"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.darkGray}
                accessibilityLabel={t( "CROP-PHOTO" )}
                disabled={!canCropSelectedPhotos}
                onPress={cropSelectedPhotos}
                testID="GroupPhotos.crop"
              />
            </View>
            <View className="flex-1 items-center">
              <INatIconButton
                icon="combine"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.darkGray}
                accessibilityLabel={t( "Combine-Photos" )}
                disabled={noObsSelected || oneObsSelected}
                onPress={combinePhotos}
              />
            </View>
          </View>
        )}
        <Button
          className="max-w-[500px] w-full"
          level="focus"
          text={t( "IMPORT-X-OBSERVATIONS", { count: groupedPhotos.length } )}
          onPress={navBasedOnUserSettings}
          testID="GroupPhotos.next"
          loading={isCreatingObservations}
        />
      </View>
    </SharedStackViewWrapper>
  );
};

export default GroupPhotos;
