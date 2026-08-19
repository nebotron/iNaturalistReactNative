import type {
  FlashListProps, FlashListRef, ListRenderItem, ViewToken,
} from "@shopify/flash-list";
import {
  Button,
  CustomFlashList,
  INatIconButton,
  WarningSheet,
} from "components/SharedComponents";
import { SharedStackViewWrapper } from "components/SharedComponents/ViewWrapper";
import { View } from "components/styledComponents";
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { preloadImage } from "sharedHelpers/imageCropPreload";
import type { NormalizedCrop } from "sharedHelpers/normalizedCropTypes";
import {
  prefetchDeviceImageThumbnails,
  prioritizeDeviceImageThumbnails,
} from "sharedHelpers/useDeviceImageThumbnail";
import { useGridLayout, useTranslation } from "sharedHooks";
import { getShadow } from "styles/global";
import colors from "styles/tailwindColors";

import GroupPhotoImage from "./GroupPhotoImage";
import { groupPhotoCropSourceUri } from "./helpers/groupPhotoCrops";
import flattenAndOrderSelectedPhotos from "./helpers/groupPhotoHelpers";
import groupPhotoThumbnailMaxPixel from "./helpers/groupPhotoThumbnail";
import preloadGroupPhotoSubjectDetection from "./helpers/preloadGroupPhotoSubjectDetection";

const DROP_SHADOW = getShadow( { offsetHeight: -2 } );

// How many items on either side of the viewport are warmed ahead of the cells
// on screen. Behind matters as much as ahead here: scrolling back up is where
// photos looked like they had unloaded.
const PREFETCH_AHEAD = 12;
const PREFETCH_BEHIND = 8;

// Button (58) plus the toolbar's vertical padding
const TOOLBAR_HEIGHT = 82;

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

interface Props {
  combinePhotos: ( ) => void;
  discardImport: ( ) => void;
  duplicateItem: ( item: Item ) => void;
  flashListRef?: React.RefObject<FlashListRef<Item> | null>;
  groupedPhotos: Item[];
  isCreatingObservations?: boolean;
  isDuplicatingPhotos?: boolean;
  navBasedOnUserSettings: ( ) => void;
  onScroll?: FlashListProps<Item>["onScroll"];
  onViewableItemsChanged?: ( info: {
    viewableItems: ViewToken<Item>[];
    changed: ViewToken<Item>[];
  } ) => void;
  removeItem: ( item: Item ) => void;
  selectedObservations: Item[];
  selectObservationPhotos: ( isSelected: boolean, item: Item ) => void;
  separateItem: ( item: Item ) => void;
}

const GroupPhotos = ( {
  combinePhotos,
  discardImport,
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
  selectObservationPhotos,
  separateItem,
}: Props ) => {
  const { t } = useTranslation( );
  const [showDiscardSheet, setShowDiscardSheet] = useState( false );
  const {
    flashListStyle,
    gridItemStyle,
    gridItemWidth,
    numColumns,
  } = useGridLayout( undefined, "fullWidth" );
  // Keyed on the media itself, never the index: mixing the index in gave every
  // item below a deleted one a brand new key, so the whole rest of the grid was
  // treated as new items and recycled onto different photos at once.
  const extractKey = ( item: Item ) => (
    item.photos?.[0]?.image.uri ?? item.soundUri ?? ""
  );

  const multiplePhotosSelected = selectedObservations.length > 1;

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

  // Warm the thumbnail and subject detection for every photo in the import, not
  // just the cells the list has mounted. A cell can only frame its crop once
  // both have landed, so a photo first reached by scrolling used to start that
  // work when it was already on screen and sat uncropped until it finished.
  // Everything here is queued behind the visible cells, so it costs them
  // nothing.
  useEffect( ( ) => {
    if ( !gridItemWidth || groupedPhotos.length === 0 ) {
      return ( ) => {};
    }
    return preloadGroupPhotoSubjectDetection( groupedPhotos, gridItemWidth );
  }, [gridItemWidth, groupedPhotos] );

  // Read through a ref so the viewability callback stays stable; FlashList
  // treats a changed onViewableItemsChanged as a fresh viewability config.
  const viewportRef = useRef( { groupedPhotos, gridItemWidth, onViewableItemsChanged } );
  useEffect( ( ) => {
    viewportRef.current = { groupedPhotos, gridItemWidth, onViewableItemsChanged };
  }, [gridItemWidth, groupedPhotos, onViewableItemsChanged] );

  // Pin the thumbnails for the photos on screen (and the ones just outside it)
  // to the front of the generation queue. A thumbnail a visible cell asked for
  // used to be dropped as soon as that cell was recycled away, so scrolling
  // back to a photo found it ungenerated again and the cell fell back to a
  // placeholder; a prioritized photo is never dropped, so a photo that has been
  // on screen once stays instantly available.
  const handleViewableItemsChanged = useCallback( ( info: {
    viewableItems: ViewToken<Item>[];
    changed: ViewToken<Item>[];
  } ) => {
    const { groupedPhotos: items, gridItemWidth: cellWidth } = viewportRef.current;
    viewportRef.current.onViewableItemsChanged?.( info );
    if ( !cellWidth || info.viewableItems.length === 0 ) return;
    const maxPixel = groupPhotoThumbnailMaxPixel( cellWidth );
    const indices = info.viewableItems
      .map( token => token.index )
      .filter( ( index ): index is number => typeof index === "number" );
    if ( indices.length === 0 ) return;
    const first = Math.min( ...indices );
    const last = Math.max( ...indices );
    // Both uris matter: the cell draws image.uri and the crop overlay zooms the
    // uncropped original, which are the same file until a crop has been baked.
    const urisAt = ( index: number ) => ( items[index]?.photos ?? [] ).flatMap( photo => [
      photo.image.uri,
      groupPhotoCropSourceUri( photo.image ),
    ] );

    const visible: string[] = [];
    for ( let i = first; i <= last; i += 1 ) visible.push( ...urisAt( i ) );
    prioritizeDeviceImageThumbnails( visible, maxPixel );

    // Enqueued least-urgent first: the queue is LIFO, so the items just off the
    // leading edge of the viewport are generated first.
    const nearby: string[] = [];
    for ( let i = Math.max( 0, first - PREFETCH_BEHIND ); i < first; i += 1 ) {
      nearby.push( ...urisAt( i ) );
    }
    for ( let i = Math.min( items.length - 1, last + PREFETCH_AHEAD ); i > last; i -= 1 ) {
      nearby.push( ...urisAt( i ) );
    }
    prefetchDeviceImageThumbnails( nearby, maxPixel );
  }, [] );

  const renderItem: ListRenderItem<Item> = useCallback( ( { item } ) => (
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

  // The import/discard buttons scroll with the list so they're only
  // reachable once the user has scrolled to the end of their photos.
  const footerComponent = useMemo( ( ) => (
    <View className="items-center px-2 pt-4">
      <View className="flex-row w-full max-w-[500px] gap-2">
        <Button
          level="neutral"
          text={t( "DISCARD" )}
          onPress={( ) => setShowDiscardSheet( true )}
          testID="GroupPhotos.discard"
        />
        <Button
          className="flex-1"
          level="focus"
          text={t( "IMPORT-X-OBSERVATIONS", { count: groupedPhotos.length } )}
          onPress={navBasedOnUserSettings}
          testID="GroupPhotos.next"
          loading={isCreatingObservations}
        />
      </View>
    </View>
  ), [groupedPhotos.length, isCreatingObservations, navBasedOnUserSettings, t] );

  const extraData = {
    selectedObservations,
  };

  // Leave room under the footer buttons for the floating combine overlay
  const listStyle = useMemo( ( ) => ( {
    ...flashListStyle,
    paddingBottom: multiplePhotosSelected
      ? TOOLBAR_HEIGHT + 20
      : 20,
  } ), [flashListStyle, multiplePhotosSelected] );

  return (
    <SharedStackViewWrapper>
      <CustomFlashList
        ListFooterComponent={footerComponent}
        contentContainerStyle={listStyle}
        data={groupedPhotos}
        extraData={extraData}
        key={numColumns}
        keyExtractor={extractKey}
        numColumns={numColumns}
        onScroll={onScroll}
        onViewableItemsChanged={handleViewableItemsChanged}
        ref={flashListRef}
        renderItem={renderItem}
        testID="GroupPhotos.list"
      />
      {multiplePhotosSelected && (
        <View
          className="absolute bottom-0 w-full bg-white z-50 items-center px-2 pt-2 pb-4"
          style={DROP_SHADOW}
        >
          <INatIconButton
            icon="combine"
            mode="contained"
            size={26}
            width={58}
            height={58}
            color={colors.white}
            backgroundColor={colors.darkGray}
            accessibilityLabel={t( "Combine-Photos" )}
            onPress={combinePhotos}
            testID="GroupPhotos.combine"
          />
        </View>
      )}
      {showDiscardSheet && (
        <WarningSheet
          onPressClose={( ) => setShowDiscardSheet( false )}
          headerText={t( "DISCARD-PHOTOS--question" )}
          text={t( "By-exiting-your-photos-will-not-be-saved" )}
          secondButtonText={t( "CANCEL" )}
          handleSecondButtonPress={( ) => setShowDiscardSheet( false )}
          buttonText={t( "DISCARD-ALL" )}
          testID="GroupPhotos.discardSheet"
          confirm={( ) => {
            setShowDiscardSheet( false );
            discardImport( );
          }}
          loading={false}
        />
      )}
    </SharedStackViewWrapper>
  );
};

export default GroupPhotos;
