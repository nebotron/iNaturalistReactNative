import { useNavigation } from "@react-navigation/native";
import type { ListRenderItem } from "@shopify/flash-list";
import { MAX_PHOTOS_ALLOWED } from "components/Camera/StandardCamera/StandardCamera";
import {
  Body2,
  Button,
  ButtonBar,
  CustomFlashList,
  FloatingActionBar,
  INatIcon,
  INatIconButton,
} from "components/SharedComponents";
import ViewWrapper from "components/SharedComponents/ViewWrapper";
import { Pressable, View } from "components/styledComponents";
import React, { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import { useGridLayout, useTranslation } from "sharedHooks";
import colors from "styles/tailwindColors";

import GroupPhotoImage from "./GroupPhotoImage";
import flattenAndOrderSelectedPhotos from "./helpers/groupPhotoHelpers";

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
  groupedPhotos: Item[];
  isCreatingObservations?: boolean;
  navBasedOnUserSettings: ( ) => void;
  removePhotos: ( ) => void;
  selectedObservations: Item[];
  selectAllPhotos: ( ) => void;
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separatePhotos: ( ) => void;
  totalPhotos: number;
  selectedGroupsHaveMixedMedia?: boolean;
}

const GroupPhotos = ( {
  combinePhotos,
  clearSelection,
  groupedPhotos,
  isCreatingObservations,
  navBasedOnUserSettings,
  removePhotos,
  selectedObservations,
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
    squareCorners,
  } = useGridLayout( undefined, "fullWidth" );
  const [buttonBarHeight, setButtonBarHeight] = useState<number | null>( null );
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
      squareCorners={squareCorners}
      style={gridItemStyle}
    />
  ), [gridItemStyle, selectedObservations, selectObservationPhotos, squareCorners] );

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

  const onLayout = ( event: LayoutChangeEvent ) => {
    const {
      height,
    } = event.nativeEvent.layout;
    setButtonBarHeight( height );
  };

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
        renderItem={renderItem}
        testID="GroupPhotos.list"
      />
      <FloatingActionBar
        show={groupedPhotos.length > 0 && typeof buttonBarHeight === "number"}
        position="bottomStart"
        containerClass="ml-[15px] rounded-md"
        footerHeight={buttonBarHeight ?? 0}
      >
        <View className="rounded-md overflow-hidden flex-row">
          <INatIconButton
            icon="check"
            mode="contained"
            size={20}
            color={colors.white}
            backgroundColor={colors.darkGray}
            className="m-4"
            accessibilityLabel={
              allPhotosSelected
                ? t( "Deselect-all-photos" )
                : t( "Select-all-photos" )
            }
            onPress={toggleSelectAll}
            testID="GroupPhotos.selectAll"
          />
          <INatIconButton
            icon="crop"
            mode="contained"
            size={20}
            color={colors.white}
            backgroundColor={colors.darkGray}
            className="m-4"
            accessibilityLabel={t( "CROP-PHOTO" )}
            disabled={!canCropSelectedPhotos}
            onPress={cropSelectedPhotos}
            testID="GroupPhotos.crop"
          />
          <INatIconButton
            icon="combine"
            mode="contained"
            size={20}
            color={colors.white}
            backgroundColor={colors.darkGray}
            className="m-4"
            accessibilityLabel={t( "Combine-Photos" )}
            disabled={noObsSelected || oneObsSelected || selectedGroupsHaveMixedMedia}
            onPress={combinePhotos}
          />
          <INatIconButton
            icon="separate"
            mode="contained"
            size={20}
            color={colors.white}
            backgroundColor={colors.darkGray}
            className="m-4"
            accessibilityLabel={t( "Separate-Photos" )}
            disabled={!obsWithMultiplePhotosSelected}
            onPress={separatePhotos}
          />
          <INatIconButton
            icon="trash-outline"
            mode="contained"
            size={20}
            color={colors.white}
            backgroundColor={colors.warningRed}
            className="m-4"
            accessibilityLabel={t( "Remove-Photos" )}
            disabled={noObsSelected}
            onPress={removePhotos}
          />
        </View>
      </FloatingActionBar>
      <ButtonBar
        sticky
        containerClass="items-center z-50 bg-white"
        onLayout={onLayout}
      >
        <Button
          className="max-w-[500px] w-full"
          level="focus"
          text={t( "IMPORT-X-OBSERVATIONS", { count: groupedPhotos.length } )}
          onPress={navBasedOnUserSettings}
          testID="GroupPhotos.next"
          loading={isCreatingObservations}
        />
      </ButtonBar>
    </ViewWrapper>
  );
};

export default GroupPhotos;
