import { useNavigation } from "@react-navigation/native";
import type { FlashListProps, FlashListRef, ListRenderItem, ViewToken } from "@shopify/flash-list";
import { MAX_PHOTOS_ALLOWED } from "components/Camera/StandardCamera/StandardCamera";
import {
  Body2,
  Button,
  CustomFlashList,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import ViewWrapper from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import React, { useCallback, useMemo } from "react";
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

interface VideoItem {
  uri: string;
}

interface Item {
  photos?: PhotoItem[];
  videos?: VideoItem[];
}

type GroupPhotosListItem = Item | { empty: true };

function isEmptyGridItem( item: GroupPhotosListItem ): item is { empty: true } {
  return "empty" in item && item.empty === true;
}

interface Props {
  combinePhotos: ( ) => void;
  clearSelection: ( ) => void;
  duplicatePhotos: ( ) => void | Promise<void>;
  flashListRef?: React.RefObject<FlashListRef<GroupPhotosListItem> | null>;
  groupedPhotos: Item[];
  isCreatingObservations?: boolean;
  isDuplicatingPhotos?: boolean;
  maxPhotosAllowed: number;
  navBasedOnUserSettings: ( ) => void;
  onScroll?: FlashListProps<GroupPhotosListItem>["onScroll"];
  onViewableItemsChanged?: ( info: {
    viewableItems: ViewToken<GroupPhotosListItem>[];
    changed: ViewToken<GroupPhotosListItem>[];
  } ) => void;
  removePhotos: ( ) => void;
  selectedObservations: Item[];
  selectedMediaCount: number;
  selectAllPhotos: ( ) => void;
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separatePhotos: ( ) => void;
  totalPhotos: number;
  selectedGroupsHaveMixedMedia?: boolean;
}

const GroupPhotos = ( {
  combinePhotos,
  clearSelection,
  duplicatePhotos,
  flashListRef,
  groupedPhotos,
  isCreatingObservations,
  isDuplicatingPhotos,
  maxPhotosAllowed,
  navBasedOnUserSettings,
  onScroll,
  onViewableItemsChanged,
  removePhotos,
  selectedObservations,
  selectedMediaCount,
  selectAllPhotos,
  selectObservationPhotos,
  separatePhotos,
  totalPhotos,
  selectedGroupsHaveMixedMedia = false,
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
      : `${item.photos?.[0]?.image.uri || item.videos?.[0]?.uri}${index}`
  );

  const noObsSelected = selectedObservations.length === 0;
  const oneObsSelected = selectedObservations.length === 1;
  const obsWithMultiplePhotosSelected = selectedObservations.some(
    obs => ( obs.photos?.length || obs.videos?.length || 0 ) > 1,
  );
  const selectedPhotoUris = useMemo(
    ( ) => flattenAndOrderSelectedPhotos( selectedObservations )
      .map( photo => photo.image.uri ),
    [selectedObservations],
  );
  const canCropSelectedPhotos = !selectedGroupsHaveMixedMedia
    && selectedPhotoUris.length > 0;
  const canDuplicateSelectedPhotos = !selectedGroupsHaveMixedMedia
    && selectedMediaCount > 0
    && totalPhotos + selectedMediaCount <= maxPhotosAllowed;
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
      item={item}
      selectedObservations={selectedObservations}
      selectObservationPhotos={selectObservationPhotos}
      style={gridItemStyle}
    />
  ), [gridItemStyle, selectedObservations, selectObservationPhotos] );

  const addPhotos = useCallback( () => {
    navigation.navigate( "NoBottomTabStackNavigator", {
      screen: "PhotoLibrary",
      params: { fromGroupPhotos: true },
    } );
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
    <ViewWrapper useTopInset={false}>
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
                disabled={noObsSelected || oneObsSelected || selectedGroupsHaveMixedMedia}
                onPress={combinePhotos}
              />
            </View>
            <View className="flex-1 items-center">
              <INatIconButton
                icon="separate"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.darkGray}
                accessibilityLabel={t( "Separate-Photos" )}
                disabled={!obsWithMultiplePhotosSelected}
                onPress={separatePhotos}
              />
            </View>
            <View className="flex-1 items-center">
              <INatIconButton
                icon="copy"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.darkGray}
                accessibilityLabel={t( "Duplicate-Photos" )}
                disabled={!canDuplicateSelectedPhotos || isDuplicatingPhotos}
                onPress={duplicatePhotos}
                testID="GroupPhotos.duplicate"
              />
            </View>
            <View className="flex-1 items-center">
              <INatIconButton
                icon="trash-outline"
                mode="contained"
                size={26}
                width={58}
                height={58}
                color={colors.white}
                backgroundColor={colors.warningRed}
                accessibilityLabel={t( "Remove-Photos" )}
                disabled={noObsSelected}
                onPress={removePhotos}
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
    </ViewWrapper>
  );
};

export default GroupPhotos;
