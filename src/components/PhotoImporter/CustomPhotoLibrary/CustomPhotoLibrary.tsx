import type { ListRenderItem } from "@shopify/flash-list";
import {
  Body2,
  Button,
  CustomFlashList,
  Heading4,
  InfiniteScrollLoadingWheel,
  ViewWrapper,
} from "components/SharedComponents";
import { View } from "components/styledComponents";
import { RealmContext } from "providers/contexts";
import React, {
  useCallback,
  useMemo,
  useState,
} from "react";
import { ActivityIndicator } from "react-native";
import type { Asset } from "react-native-image-picker";
import {
  getPreviouslyUploadedDevicePhotoUrisSet,
} from "sharedHelpers/duplicateUploadedDevicePhotos";
import { useGridLayout, useTranslation } from "sharedHooks";
import useStore from "stores/useStore";

import buildPhotoLibraryListItems from "./helpers/buildPhotoLibraryListItems";
import getMarkedDevicePhotoUris from "./helpers/getMarkedDevicePhotoUris";
import useDevicePhotoLibrary from "./hooks/useDevicePhotoLibrary";
import PhotoLibraryGridItem from "./PhotoLibraryGridItem";
import type { LibraryPhoto, PhotoLibraryListItem } from "./types";
import { isPhotoLibraryHeader, isPhotoLibraryRow } from "./types";

const { useRealm } = RealmContext;

interface Props {
  assetType: "mixed" | "photo";
  maxSelection: number;
  onCancel: ( ) => void;
  onConfirm: ( assets: Asset[] ) => void | Promise<void>;
}

const CustomPhotoLibrary = ( {
  assetType,
  maxSelection,
  onCancel,
  onConfirm,
}: Props ) => {
  const { t, i18n } = useTranslation( );
  const realm = useRealm( );
  const {
    flashListStyle,
    gridItemStyle,
  } = useGridLayout( undefined, "fullWidth" );
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>( () => new Set( ) );
  const [isSubmitting, setIsSubmitting] = useState( false );
  const originalDevicePhotoUris = useStore( state => state.originalDevicePhotoUris );

  const {
    error,
    hasNextPage,
    isInitialLoading,
    isLoadingMore,
    loadMorePhotos,
    photos,
  } = useDevicePhotoLibrary( {
    assetType,
    enabled: true,
  } );

  const markedDevicePhotoUris = useMemo(
    ( ) => getMarkedDevicePhotoUris( realm ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [originalDevicePhotoUris, realm, photos.length],
  );
  const previouslyUploadedUris = useMemo(
    ( ) => getPreviouslyUploadedDevicePhotoUrisSet( realm ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [realm, photos.length],
  );

  const listItems = useMemo(
    ( ) => buildPhotoLibraryListItems( photos, i18n ),
    [i18n, photos],
  );

  const photosById = useMemo( ( ) => {
    const lookup = new Map<string, LibraryPhoto>( );
    photos.forEach( photo => {
      lookup.set( photo.id, photo );
    } );
    return lookup;
  }, [photos] );

  const selectedCount = selectedPhotoIds.size;
  const selectionLimitReached = selectedCount >= maxSelection;

  const togglePhotoSelection = useCallback( ( photo: LibraryPhoto ) => {
    const isMarked = !!( photo.deviceUri && markedDevicePhotoUris.has( photo.deviceUri ) );
    if ( isMarked ) {
      return;
    }

    setSelectedPhotoIds( currentIds => {
      if ( currentIds.has( photo.id ) ) {
        const nextIds = new Set( currentIds );
        nextIds.delete( photo.id );
        return nextIds;
      }
      if ( currentIds.size >= maxSelection ) {
        if ( maxSelection === 1 ) {
          return new Set( [photo.id] );
        }
        return currentIds;
      }
      const nextIds = new Set( currentIds );
      nextIds.add( photo.id );
      return nextIds;
    } );
  }, [markedDevicePhotoUris, maxSelection] );

  const handleConfirm = useCallback( async ( ) => {
    if ( selectedCount === 0 || isSubmitting ) {
      return;
    }

    setIsSubmitting( true );
    try {
      const selectedAssets = [...selectedPhotoIds]
        .map( id => photosById.get( id )?.asset )
        .filter( ( asset ): asset is Asset => !!asset );
      await onConfirm( selectedAssets );
    } finally {
      setIsSubmitting( false );
    }
  }, [isSubmitting, onConfirm, photosById, selectedCount, selectedPhotoIds] );

  const renderRow = useCallback( ( rowPhotos: LibraryPhoto[] ) => (
    <View className="flex-row px-1">
      {rowPhotos.map( photo => {
        const isMarkedForUpload = !!(
          photo.deviceUri && markedDevicePhotoUris.has( photo.deviceUri )
        );
        const isDuplicateUpload = !!(
          photo.deviceUri && previouslyUploadedUris.has( photo.deviceUri )
        );
        const isSelected = selectedPhotoIds.has( photo.id );

        return (
          <PhotoLibraryGridItem
            key={photo.id}
            isDuplicateUpload={isDuplicateUpload}
            isMarkedForUpload={isMarkedForUpload}
            isSelected={isSelected}
            onPress={() => togglePhotoSelection( photo )}
            photo={photo}
            style={gridItemStyle}
          />
        );
      } )}
      {rowPhotos.length < 3 && (
        Array.from( { length: 3 - rowPhotos.length } ).map( ( _, index ) => (
          <View
            // eslint-disable-next-line react/no-array-index-key
            key={`spacer-${rowPhotos[0]?.id || "row"}-${index}`}
            style={gridItemStyle}
          />
        ) )
      )}
    </View>
  ), [
    gridItemStyle,
    markedDevicePhotoUris,
    previouslyUploadedUris,
    selectedPhotoIds,
    togglePhotoSelection,
  ] );

  const renderItem: ListRenderItem<PhotoLibraryListItem> = useCallback( ( { item } ) => {
    if ( isPhotoLibraryHeader( item ) ) {
      return (
        <View className="px-4 py-3 bg-white">
          <Heading4>{item.title}</Heading4>
        </View>
      );
    }

    if ( isPhotoLibraryRow( item ) ) {
      return renderRow( item.photos );
    }

    return null;
  }, [renderRow] );

  const extractKey = useCallback( ( item: PhotoLibraryListItem, index: number ) => {
    if ( isPhotoLibraryHeader( item ) ) {
      return `header-${item.dateKey}`;
    }
    if ( isPhotoLibraryRow( item ) ) {
      return `row-${item.photos.map( photo => photo.id ).join( "-" )}-${index}`;
    }
    return `item-${index}`;
  }, [] );

  const footer = useMemo( ( ) => (
    <InfiniteScrollLoadingWheel
      hideLoadingWheel={!isLoadingMore}
      isConnected
      layout="grid"
    />
  ), [isLoadingMore] );

  return (
    <ViewWrapper testID="CustomPhotoLibrary">
      <View className="flex-row items-center justify-between px-4 py-3 border-b border-lightGray">
        <Button
          level="plain"
          onPress={onCancel}
          text={t( "Cancel" )}
        />
        <Heading4>{t( "Choose-photos" )}</Heading4>
        {selectedCount > 0
          ? (
            <Button
              level="plain"
              loading={isSubmitting}
              onPress={handleConfirm}
              text={t( "Import-x-photos", { count: selectedCount } )}
            />
          )
          : <View className="w-[80px]" />}
      </View>
      {selectionLimitReached && maxSelection > 1 && (
        <View className="px-4 py-2 bg-lightGray">
          <Body2>{t( "Photo-library-selection-limit", { count: maxSelection } )}</Body2>
        </View>
      )}
      {isInitialLoading
        ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" />
          </View>
        )
        : (
          <CustomFlashList
            contentContainerStyle={flashListStyle}
            data={listItems}
            estimatedItemSize={gridItemStyle.height}
            extraData={selectedPhotoIds}
            getItemType={item => item.type}
            keyExtractor={extractKey}
            ListEmptyComponent={(
              <View className="flex-1 items-center justify-center px-8 py-16">
                <Body2 className="text-center">
                  {error || t( "No-photos-found" )}
                </Body2>
              </View>
            )}
            ListFooterComponent={hasNextPage
              ? footer
              : null}
            onEndReached={loadMorePhotos}
            onEndReachedThreshold={0.5}
            renderItem={renderItem}
          />
        )}
    </ViewWrapper>
  );
};

export default CustomPhotoLibrary;
